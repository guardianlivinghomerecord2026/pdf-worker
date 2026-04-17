import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { chromium } from "playwright";

const app = express();
app.use(express.json());

const CALLBACK_URL = process.env.BASE44_CALLBACK_URL;

async function sendUpdate(payload) {
  await axios.post(CALLBACK_URL, payload, {
    headers: {
      "Content-Type": "application/json"
    }
  });
}

async function processJob(job) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-"));

  try {
    console.log("START JOB:", job.job_id);

    await sendUpdate({
      job_id: job.job_id,
      status: "processing"
    });

    console.log("LAUNCHING BROWSER...");

    const browser = await chromium.launch({
      args: ["--no-sandbox"],
      executablePath: "/opt/render/.cache/ms-playwright/chromium-*/chrome-linux/chrome"
    });

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

    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("file", fs.createReadStream(pdfPath));

    const uploadRes = await axios.post(
      `${process.env.API_BASE}/api/upload`,
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.API_KEY}`,
          ...form.getHeaders(),
        },
      }
    );

    const pdfUrl = uploadRes.data.url;

    await sendUpdate({
      job_id: job.job_id,
      status: "complete",
      pdf_url: pdfUrl
    });

    console.log("DONE:", job.job_id);

  } catch (err) {
    console.error("ERROR:", err.message);

    await sendUpdate({
      job_id: job.job_id,
      status: "failed",
      error_message: err.message
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
