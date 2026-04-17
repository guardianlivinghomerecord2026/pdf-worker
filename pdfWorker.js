import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { chromium } from "playwright";

const app = express();
app.use(express.json());

const CALLBACK_URL = process.env.BASE44_CALLBACK_URL;

const CHROME_PATH = path.join(
  process.cwd(),
  "ms-playwright",
  fs.readdirSync(path.join(process.cwd(), "ms-playwright")).find(d => d.startsWith("chromium")),
  "chrome-linux",
  "chrome"
);

async function sendUpdate(payload) {
  try {
    await axios.post(CALLBACK_URL, payload, {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("CALLBACK ERROR:", err.message);
  }
}

async function processJob(job) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-"));

  try {
    console.log("START JOB:", job.job_id);

    await sendUpdate({
      job_id: job.job_id,
      status: "processing"
    });

    console.log("USING CHROME PATH:", CHROME_PATH);

    const browser = await chromium.launch({
      executablePath: CHROME_PATH,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.goto(job.html_url, {
      waitUntil: "networkidle",
      timeout: 60000
    });

    await page.waitForTimeout(8000);

    const pdfPath = path.join(tempDir, "output.pdf");

    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true
    });

    await browser.close();

    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("file", fs.createReadStream(pdfPath));

    const uploadRes = await axios.post(
      `${process.env.API_BASE}/api/upload`,
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.API_KEY}`,
          ...form.getHeaders()
        }
      }
    );

    await sendUpdate({
      job_id: job.job_id,
      status: "complete",
      pdf_url: uploadRes.data.url
    });

  } catch (err) {
    console.error("ERROR:", err);

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
