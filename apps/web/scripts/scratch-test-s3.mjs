import { startMultipart, presignPart, completeMultipart, listParts, head, presignGet, abort } from "../lib/storage/s3.ts";

async function test() {
  const club = "GCLUB";
  const { uploadId, key } = await startMultipart(club, 999, 888, ".mp4");
  console.log("Started multipart:", { uploadId, key });

  // S3 min part size is 5MB (5242880 bytes)
  const partSize = 5 * 1024 * 1024 + 1024; // 5MB + 1KB
  const part1 = Buffer.alloc(partSize, "a");
  const part2 = Buffer.alloc(partSize, "b");
  const part3 = Buffer.alloc(1024, "c"); // last part can be smaller

  const parts = [part1, part2, part3];
  const uploadedParts = [];

  for (let i = 0; i < parts.length; i++) {
    const url = await presignPart(club, key, uploadId, i + 1, 600);
    const res = await fetch(url, { method: "PUT", body: parts[i] });
    const etag = res.headers.get("etag");
    console.log(`Uploaded part ${i + 1}: status=${res.status}, etag=${etag}`);
    uploadedParts.push({ PartNumber: i + 1, ETag: etag });
  }

  const listed = await listParts(club, key, uploadId);
  console.log("Listed parts:", listed.length);

  await completeMultipart(club, key, uploadId, uploadedParts);
  console.log("Completed multipart!");

  const h = await head(key);
  console.log("HEAD object:", h);

  const getUrl = await presignGet(key, 10);
  const getRes = await fetch(getUrl);
  console.log("GET object status:", getRes.status, "content-length:", getRes.headers.get("content-length"));
}

test().catch(console.error);
