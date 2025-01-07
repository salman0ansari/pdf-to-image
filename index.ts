import express from "express";
import * as fs from "node:fs";
import * as path from "path";
import * as mupdfjs from "mupdf/mupdfjs";
import sharp from "sharp";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import rateLimit from "express-rate-limit";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
const port = process.env.PORT || 3000;

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Database initialization
let db: any;
async function initializeDatabase() {
  db = await open({
    filename: "images.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      filepath TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      original_url TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT
    )
  `);
}

// Initialize database on startup
initializeDatabase().catch(console.error);

// Middleware
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use(limiter);

// Utility functions
function loadPDF(data: Buffer | ArrayBuffer | Uint8Array) {
  return new mupdfjs.PDFDocument(data);
}

function drawPageAsPNG(
  document: mupdfjs.PDFDocument,
  pageNumber: number,
  dpi: number
): Uint8Array {
  const page = document.loadPage(pageNumber);
  const zoom = dpi / 72;
  return page
    .toPixmap([zoom, 0, 0, zoom, 0, 0], mupdfjs.ColorSpace.DeviceRGB)
    .asPNG();
}

async function combinePDFPagesToSingleImage(
  pdfBuffer: Buffer,
  dpi: number = 150
): Promise<Buffer> {
  const doc = loadPDF(pdfBuffer);
  const pageCount = doc.countPages();

  const pageImages = [];
  for (let i = 0; i < pageCount; i++) {
    const pageBuffer = drawPageAsPNG(doc, i, dpi);
    pageImages.push(sharp(pageBuffer));
  }

  const dimensions = await Promise.all(pageImages.map((img) => img.metadata()));

  const totalHeight = dimensions.reduce(
    (sum, dim) => sum + (dim.height || 0),
    0
  );
  const maxWidth = Math.max(...dimensions.map((dim) => dim.width || 0));

  const combinedImage = await sharp({
    create: {
      width: maxWidth,
      height: totalHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(
      await Promise.all(
        pageImages.map(async (img, index) => {
          const y = dimensions
            .slice(0, index)
            .reduce((sum, dim) => sum + (dim.height || 0), 0);
          return {
            input: await img.toBuffer(),
            top: y,
            left: 0,
          };
        })
      )
    )
    .png()
    .toBuffer();

  return combinedImage;
}

// Background processing function
async function processPDFInBackground(
  imageId: string,
  url: string,
  imagePath: string
) {
  try {
    // Download PDF
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 30000,
    });

    // Convert PDF to image
    const imageBuffer = await combinePDFPagesToSingleImage(
      Buffer.from(response.data)
    );

    // Save image
    await fs.promises.writeFile(imagePath, imageBuffer);

    // Update database status
    await db.run("UPDATE images SET status = ? WHERE id = ?", [
      "completed",
      imageId,
    ]);
  } catch (error) {
    console.error(`Error processing PDF ${imageId}:`, error);
    await db.run(
      "UPDATE images SET status = ?, error_message = ? WHERE id = ?",
      [
        "failed",
        error instanceof Error ? error.message : "Unknown error",
        imageId,
      ]
    );
  }
}

// Add this utility function near other utility functions
function isValidBase64(str: string): boolean {
  try {
    return Buffer.from(str, "base64").toString("base64") === str;
  } catch {
    return false;
  }
}

// Routes
app.post("/pdf2image", async (req: express.Request, res: express.Response) => {
  try {
    const { url, base64 } = req.body;

    // Check if either url or base64 is provided
    if (!url && !base64) {
      return res
        .status(400)
        .json({ error: "Either PDF URL or base64 data is required" });
    }

    // Check if both are provided
    if (url && base64) {
      return res
        .status(400)
        .json({ error: "Please provide either URL or base64 data, not both" });
    }

    // Validate base64 if provided
    if (base64 && !isValidBase64(base64)) {
      return res.status(400).json({ error: "Invalid base64 data" });
    }

    const imageId = uuidv4();
    const imagePath = path.join(uploadsDir, `${imageId}.png`);

    // Create initial database entry
    await db.run(
      "INSERT INTO images (id, filepath, original_url, status) VALUES (?, ?, ?, ?)",
      [imageId, imagePath, url || null, "processing"]
    );

    if (base64) {
      // Process base64 data immediately
      try {
        const pdfBuffer = Buffer.from(base64, "base64");
        const imageBuffer = await combinePDFPagesToSingleImage(pdfBuffer);
        await fs.promises.writeFile(imagePath, imageBuffer);
        await db.run("UPDATE images SET status = ? WHERE id = ?", [
          "completed",
          imageId,
        ]);
      } catch (error) {
        console.error(`Error processing PDF ${imageId}:`, error);
        await db.run(
          "UPDATE images SET status = ?, error_message = ? WHERE id = ?",
          [
            "failed",
            error instanceof Error ? error.message : "Unknown error",
            imageId,
          ]
        );
      }
    } else {
      // Process URL in background as before
      processPDFInBackground(imageId, url, imagePath);
    }

    // Return response
    res.json({
      imageId,
      message:
        "PDF conversion started. Use this ID to check status and retrieve the image.",
      statusEndpoint: `/status/${imageId}`,
      imageEndpoint: `/getimage/${imageId}`,
      deleteEndpoint: `/deleteimage/${imageId}`,
    });
  } catch (error) {
    console.error("Error initiating PDF processing:", error);
    res.status(500).json({
      error: "Failed to initiate PDF processing",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get(
  "/getimage/:imageId",
  async (req: express.Request, res: express.Response) => {
    try {
      const { imageId } = req.params;

      const image = await db.get("SELECT * FROM images WHERE id = ?", [
        imageId,
      ]);

      if (!image) {
        return res.status(404).json({ error: "Image not found" });
      }

      if (image.status === "processing") {
        return res.status(202).json({
          status: "processing",
          message: "Image is still being processed",
          statusEndpoint: `/status/${imageId}`,
        });
      }

      if (image.status === "failed") {
        return res.status(500).json({
          error: "Image processing failed",
          details: image.error_message,
        });
      }

      if (!fs.existsSync(image.filepath)) {
        return res.status(404).json({ error: "Image file not found" });
      }

      res.setHeader("Content-Type", "image/png");
      fs.createReadStream(image.filepath).pipe(res);
    } catch (error) {
      console.error("Error serving image:", error);
      res.status(500).json({
        error: "Failed to serve image",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

app.get(
  "/status/:imageId",
  async (req: express.Request, res: express.Response) => {
    try {
      const { imageId } = req.params;
      const image = await db.get(
        "SELECT id, status, created_at, error_message FROM images WHERE id = ?",
        [imageId]
      );

      if (!image) {
        return res.status(404).json({ error: "Image not found" });
      }

      res.json(image);
    } catch (error) {
      console.error("Error checking status:", error);
      res.status(500).json({ error: "Failed to check status" });
    }
  }
);

// New delete endpoint
app.get(
  "/deleteimage/:imageId",
  async (req: express.Request, res: express.Response) => {
    try {
      const { imageId } = req.params;

      // Get image info from database
      const image = await db.get("SELECT * FROM images WHERE id = ?", [
        imageId,
      ]);

      if (!image) {
        return res.status(404).json({ error: "Image not found" });
      }

      // Delete the file if it exists
      if (fs.existsSync(image.filepath)) {
        await fs.promises.unlink(image.filepath);
      }

      // Delete database entry
      await db.run("DELETE FROM images WHERE id = ?", [imageId]);

      res.json({
        message: "Image deleted successfully",
        imageId,
      });
    } catch (error) {
      console.error("Error deleting image:", error);
      res.status(500).json({
        error: "Failed to delete image",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

export default app;
