import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { chromium } from "playwright";

const app = express();
app.use(express.json());

const API_BASE = process.env.API_BASE; // https://yourapp.base44.app
const API_KEY = process.env.API_KEY;

// ✅ CORRECT endpoint + method
async function updateJob(id, data) {
  await axios.patch(`${API_BASE}/api/entities/PdfJob/${id}`, data, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    }
  });
}

async function uploadPdf(filePath) {
  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));

  const res = await axios.post(`${API_BASE}/api/upload`, form, {
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

    console.log("LOADING PAGE...");
    await page.goto(job.html_url, {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    console.log("WAITING FOR IMAGES...");
    await page.waitForTimeout(8000);

    await page.addStyleTag({
      content: `
        body { zoom: 0.95; }
        img { max-width: 100%; height: auto; page-break-inside: avoid; }
        h1, h2, h3, h4 { page-break-after: avoid; }
      `
    });

    const pdfPath = path.join(tempDir, "output.pdf");

    console.log("GENERATING PDF...");
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      timeout: 120000,
    });

    await browser.close();

    console.log("UPLOADING PDF...");
    const pdfUrl = await uploadPdf(pdfPath);

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
