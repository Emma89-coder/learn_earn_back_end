"""
OCR-based PDF extraction for LearnEarn.
Called by the Node.js backend when pdf-parse can't extract text (scanned PDFs).

Usage: python ocr_extract.py <pdf_path> <output_json_path>

Requirements:
  pip install pytesseract pypdfium2 langchain-community Pillow
  Tesseract OCR must be installed: C:\Program Files\Tesseract-OCR\tesseract.exe
"""

import sys
import json
import os

try:
    import pytesseract
    from langchain_community.document_loaders import PyPDFium2Loader
except ImportError as e:
    print(json.dumps({"success": False, "error": f"Missing dependency: {e}. Run: pip install pytesseract pypdfium2 langchain-community Pillow"}))
    sys.exit(1)

# Set Tesseract path
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

def extract_pdf(pdf_path, output_path):
    try:
        if not os.path.exists(pdf_path):
            return {"success": False, "error": f"File not found: {pdf_path}"}

        # Load PDF with OCR and image extraction
        loader = PyPDFium2Loader(pdf_path, extract_images=True)
        documents = loader.load()

        pages = []
        full_text = ""

        for i, doc in enumerate(documents):
            page_text = doc.page_content or ""
            full_text += page_text + "\n"
            pages.append({
                "page": i + 1,
                "text": page_text,
                "chars": len(page_text)
            })

        result = {
            "success": True,
            "total_pages": len(documents),
            "total_chars": len(full_text),
            "full_text": full_text,
            "pages": pages
        }

        # Write output
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False)

        return result

    except Exception as e:
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"success": False, "error": "Usage: python ocr_extract.py <pdf_path> <output_json_path>"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    output_path = sys.argv[2]

    result = extract_pdf(pdf_path, output_path)
    print(json.dumps({"success": result["success"], "pages": result.get("total_pages", 0), "chars": result.get("total_chars", 0)}))
