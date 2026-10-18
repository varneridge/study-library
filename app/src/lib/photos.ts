// Photos as readings. A chapter photographed on a phone arrives as several
// pictures, so pictures added together become one PDF reading, one page per
// picture, in the order they were chosen. It happens on the device, so it
// works offline, and to the processor it is a scan like any other: it reads
// the text, turns the pages upright and straightens them.

import { shortDate } from "./dates";

const IMAGE_NAME = /\.(jpe?g|png|webp|gif|heic|heif|tiff?|bmp)$/i;

export const isImage = (file: File) => file.type.startsWith("image/") || IMAGE_NAME.test(file.name);

// The longest side of a page, in pixels. Enough for OCR at about 200 dpi,
// small enough to upload quickly over a phone's connection.
const LONG_SIDE = 2600;

async function toJpeg(file: File): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  // The picture's own orientation, so a page photographed sideways is drawn
  // the way the camera saw it; the processor turns it upright after.
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`${file.name} could not be read as a picture. On a computer, HEIC photos may need saving as JPEG first.`);
  }
  const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The picture could not be encoded."))), "image/jpeg", 0.85));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}

// A PDF of JPEG pages. Each page is the picture at 200 dpi, so a photo of
// an A4 page comes out close to A4.
export function jpegPdf(pages: { bytes: Uint8Array; width: number; height: number }[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const write = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, body: () => void) => {
    offsets[id] = length;
    write(`${id} 0 obj\n`);
    body();
    write("\nendobj\n");
  };
  write("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  object(1, () => write("<< /Type /Catalog /Pages 2 0 R >>"));
  object(2, () => write(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`));
  pages.forEach((page, i) => {
    const id = 3 + i * 3;
    const w = (page.width * 72) / 200;
    const h = (page.height * 72) / 200;
    const content = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} 0 0 cm /Im0 Do Q`;
    object(id, () => write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w.toFixed(2)} ${h.toFixed(2)}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`));
    object(id + 1, () => write(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    object(id + 2, () => {
      write(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`);
      write(page.bytes);
      write("\nendstream");
    });
  });
  const count = 3 + pages.length * 3;
  const xref = length;
  write(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id += 1) write(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  write(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

// Replaces the pictures in a batch with one PDF of them; other files pass
// through as they are. One picture keeps its own name; several are named
// for the day and the number of pages, and can be renamed like any reading.
export async function combinePhotos(files: File[]): Promise<File[]> {
  const photos = files.filter(isImage);
  if (!photos.length) return files;
  const pages = [];
  for (const photo of photos) pages.push(await toJpeg(photo));
  const name = photos.length === 1
    ? photos[0].name.replace(IMAGE_NAME, ".pdf")
    : `Photos ${shortDate(new Date(), { year: true })} (${photos.length} pages).pdf`;
  const pdf = new File([jpegPdf(pages) as Uint8Array<ArrayBuffer>], name, { type: "application/pdf", lastModified: Date.now() });
  return [...files.filter((f) => !isImage(f)), pdf];
}

// What file pickers for readings accept: documents, and pictures to combine.
export const READING_ACCEPT = ".pdf,.pptx,.ppt,.docx,.doc,image/*,.heic,.heif";
