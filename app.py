import fitz  # PyMuPDF
from PIL import Image
import requests
import os


def download_pdf(url, save_path):
    """Download PDF from URL and save it locally."""
    response = requests.get(url)
    if response.status_code == 200:
        with open(save_path, "wb") as f:
            f.write(response.content)
        print("PDF downloaded successfully.")
        return save_path
    else:
        raise Exception("Failed to download PDF.")


def pdf_to_image(pdf_path, output_image_path="output_image.jpg", zoom_factor=2):
    """Convert PDF to a single image with improved clarity."""
    pdf_document = fitz.open(pdf_path)
    images = []
    
    for page_num in range(len(pdf_document)):
        # render page to an image with a zoom factor for higher DPI
        page = pdf_document[page_num]
        matrix = fitz.Matrix(zoom_factor, zoom_factor)  # increase resolution
        pix = page.get_pixmap(matrix=matrix)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        images.append(img)

    pdf_document.close()

    if not images:
        raise ValueError("No images extracted from the PDF.")

    # combine images vertically into one
    total_height = sum(img.height for img in images)
    max_width = max(img.width for img in images)

    # create a blank image with the combined size
    combined_image = Image.new("RGB", (max_width, total_height))

    # merge all images into 1
    y_offset = 0
    for img in images:
        combined_image.paste(img, (0, y_offset))
        y_offset += img.height

    # save the final image
    combined_image.save(output_image_path)
    print(f"PDF converted to image and saved as '{output_image_path}'.")


def main():
    input_path = input("Enter the file path or URL of the PDF: ").strip()
    save_path = "downloaded_pdf.pdf"

    try:
        if input_path.startswith("http://") or input_path.startswith("https://"):
            # Download PDF from URL
            pdf_path = download_pdf(input_path, save_path)
        else:
            # Use the file path
            pdf_path = input_path

        # Convert PDF to a single image
        pdf_to_image(pdf_path)

        # Cleanup downloaded file if applicable
        if pdf_path == save_path:
            os.remove(save_path)

    except Exception as e:
        print(f"Error: {e}")


if __name__ == "__main__":
    main()
