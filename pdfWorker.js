import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";

const app = express();
app.use(express.json());

const API_BASE = process.env.API_BASE;
const API_KEY = process.env.API_KEY;

async function updateJob(id, data) {
  await axios.patch(`${API_BASE}/PdfJob/${id}`, data, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
}

async function uploadPdf(filePath) {
  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));

  const res = await axios.post(`${API_BASE}/upload`, form, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...form.getHeaders(),
    },
  });

  return res.data.url;
}

async function processJob(job) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-"));

  try {
    console.log("START JOB:", job.job_id);
    await updateJob(job.job_id, { status: "processing" });

    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage();

    await page.goto(job.html_url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Give images time to load
    await page.waitForTimeout(5000);

    const totalHeight = await page.evaluate(() => document.body.scrollHeight);
    const chunkHeight = 1400;

    let pdfPaths = [];

    for (let offset = 0; offset < totalHeight; offset += chunkHeight) {
      console.log("Chunk:", offset);

      await page.evaluate((y) => window.scrollTo(0, y), offset);
      await page.waitForTimeout(1000);

      const pdfPath = path.join(tempDir, `chunk-${offset}.pdf`);

      await page.pdf({
        path: pdfPath,
        width: "800px",
        height: "1400px",
        printBackground: true
      });

      pdfPaths.push(pdfPath);
    }

    await browser.close();

    // Merge PDFs
    const mergedPdf = await PDFDocument.create();

    for (const file of pdfPaths) {
      const bytes = fs.readFileSync(file);
      const pdf = await PDFDocument.load(bytes);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(p => mergedPdf.addPage(p));
    }

    const finalPath = path.join(tempDir, "final.pdf");
    const finalBytes = await mergedPdf.save();
    fs.writeFileSync(finalPath, finalBytes);

    const pdfUrl = await uploadPdf(finalPath);

    await updateJob(job.job_id, {
      status: "complete",
      pdf_url: pdfUrl,
    });

    console.log("DONE:", job.job_id);

  } catch (err) {
    console.error("ERROR:", err.message);

    await updateJob(job.job_id, {
      status: "failed",
      error: err.message,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

app.post("/process", async (req, res) => {
  processJob(req.body);
  res.json({ started: true });
});

app.listen(3000, () => {
  console.log("Worker running");
});
