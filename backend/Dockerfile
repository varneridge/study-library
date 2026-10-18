FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra tesseract-ocr-deu unpaper ghostscript pngquant \
      libreoffice-impress libreoffice-writer fonts-dejavu fonts-liberation fonts-crosextra-carlito \
      ffmpeg \
 && apt-get update \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt "ocrmypdf==16.*"
COPY study ./study

RUN useradd --create-home worker
USER worker

CMD ["python", "-m", "study.processor"]
