import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import * as cheerio from "cheerio";
import { chromium } from "playwright";

const app = express();
app.use(express.json());

const API_BASE = process.env.API_BASE;
const API_KEY = process.env.API_KEY;

async function downloadFile(url, filePath) {
  const res = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${API_KEY}`
    }
  });

  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    res.data.pipe(stream);
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

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
    await updateJob(job.job_id, { status: "processing" });

    const htmlRes = await axios.get(job.html_url, {
      headers: {
        Authorization: `Bearer ${API_KEY}`
      }
    });

    const $ = cheerio.load(htmlRes.data);

    const imgs = $("img");
    const tasks = [];

    imgs.each((i, el) => {
      const src = $(el).attr("src");
      if (!src || src.startsWith("data:")) return;

      let fullUrl = src;

      // HANDLE RELATIVE PATHS + AUTH FILES
      if (!src.startsWith("http")) {
        fullUrl = `${API_BASE}${src}`;
      }

      const filePath = path.join(tempDir, `img-${i}.jpg`);

      tasks.push(
        downloadFile(fullUrl, filePath).then(() => {
          $(el).attr("src", `file://${filePath}`);
        })
      );
    });

    await Promise.all(tasks);

    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage();

    await page.setContent($.html(), { waitUntil: "load" });

    const pdfPath = path.join(tempDir, "output.pdf");

    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
    });

    await browser.close();

    const pdfUrl = await uploadPdf(pdfPath);

    await updateJob(job.job_id, {
      status: "complete",
      pdf_url: pdfUrl,
    });
  } catch (err) {
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
