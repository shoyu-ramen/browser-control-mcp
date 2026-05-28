import { z } from "zod";
import { execFile } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from "fs";
import { join, basename, extname } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";

function execAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout || 120000, maxBuffer: 50 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        err.stdout = stdout;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function checkFfmpeg() {
  try {
    await execAsync("ffmpeg", ["-version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function ffprobe(filePath) {
  const { stdout } = await execAsync("ffprobe", [
    "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath,
  ], { timeout: 15000 });
  return JSON.parse(stdout);
}

function genId() {
  return randomBytes(6).toString("hex");
}

function formatResult(result) {
  if (!result) return { content: [{ type: "text", text: "No result" }] };
  if (result.error) return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: "text", text }] };
}

export function registerVideoTools(server, { sendCommand, sessionState, videoChunkBuffers, videoDir }) {
  const VIDEO_DIR = videoDir || join(homedir(), ".browser-control", "videos");
  if (!existsSync(VIDEO_DIR)) mkdirSync(VIDEO_DIR, { recursive: true });

  let recordingCounter = 0;
  const activeRecordings = new Map();

  function resolveVideoPath(fileId) {
    if (!fileId) return null;
    if (existsSync(fileId)) return fileId;
    const inDir = join(VIDEO_DIR, fileId);
    if (existsSync(inDir)) return inDir;
    const withExt = join(VIDEO_DIR, fileId + ".webm");
    if (existsSync(withExt)) return withExt;
    return fileId;
  }

  function genOutputPath(inputPath, suffix, newExt) {
    const ext = newExt || extname(inputPath);
    const base = basename(inputPath, extname(inputPath));
    return join(VIDEO_DIR, `${base}_${suffix}_${genId()}${ext}`);
  }

  async function requireFfmpeg() {
    if (!(await checkFfmpeg())) {
      throw new Error("FFmpeg is not installed. Install it with: brew install ffmpeg (macOS) or see https://ffmpeg.org/download.html");
    }
  }

  async function getVideoInfo(filePath) {
    const info = await ffprobe(filePath);
    const videoStream = info.streams?.find((s) => s.codec_type === "video");
    const audioStream = info.streams?.find((s) => s.codec_type === "audio");
    return {
      filePath,
      format: info.format?.format_name,
      duration: parseFloat(info.format?.duration) || null,
      size_bytes: parseInt(info.format?.size) || null,
      bitrate: parseInt(info.format?.bit_rate) || null,
      video: videoStream
        ? {
            codec: videoStream.codec_name,
            width: videoStream.width,
            height: videoStream.height,
            fps: videoStream.r_frame_rate,
            bitrate: parseInt(videoStream.bit_rate) || null,
          }
        : null,
      audio: audioStream
        ? {
            codec: audioStream.codec_name,
            sampleRate: parseInt(audioStream.sample_rate) || null,
            channels: audioStream.channels,
            bitrate: parseInt(audioStream.bit_rate) || null,
          }
        : null,
    };
  }

  // --- Recording Tools ---

  server.tool(
    "video_record_start",
    "Start recording the active browser tab as a video. Captures both visual content and audio from the tab. Returns a recording ID for tracking.",
    {
      includeAudio: z.boolean().optional().describe("Include tab audio (default: true)"),
      bitrate: z.number().optional().describe("Video bitrate in bps (default: 2500000)"),
      maxDurationMs: z.number().optional().describe("Auto-stop after this many milliseconds"),
    },
    async ({ includeAudio, bitrate, maxDurationMs }) => {
      const recordingId = `rec_${++recordingCounter}_${genId()}`;

      const result = await sendCommand("recording_start", {
        recordingId,
        includeAudio: includeAudio !== false,
        bitrate,
      }, 10000);

      if (!result?.success) {
        return formatResult({ error: result?.error || "Failed to start recording" });
      }

      videoChunkBuffers.set(recordingId, { chunks: [], startedAt: Date.now() });

      const rec = {
        id: recordingId,
        startedAt: Date.now(),
        status: "recording",
        maxDurationMs,
        stopTimer: null,
      };

      if (maxDurationMs) {
        rec.stopTimer = setTimeout(async () => {
          try {
            await sendCommand("recording_stop", { recordingId }, 10000);
            rec.status = "stopped";
          } catch {}
        }, maxDurationMs);
      }

      activeRecordings.set(recordingId, rec);

      return formatResult({
        recordingId,
        status: "recording",
        startedAt: rec.startedAt,
        ...(maxDurationMs ? { autoStopAfterMs: maxDurationMs } : {}),
      });
    }
  );

  server.tool(
    "video_record_stop",
    "Stop the current recording and save the video file. Returns the file path and metadata.",
    {
      recordingId: z.string().optional().describe("Recording ID (default: most recent)"),
      filename: z.string().optional().describe("Output filename (default: auto-generated)"),
      format: z.string().optional().describe("Convert to this format after saving (e.g. 'mp4')"),
    },
    async ({ recordingId, filename, format }) => {
      let recId = recordingId;
      if (!recId) {
        const entries = [...activeRecordings.entries()];
        const active = entries.find(([, r]) => r.status === "recording" || r.status === "paused");
        if (active) recId = active[0];
        else return formatResult({ error: "No active recording found" });
      }

      const rec = activeRecordings.get(recId);
      if (rec?.stopTimer) clearTimeout(rec.stopTimer);

      await sendCommand("recording_stop", { recordingId: recId }, 10000);

      const maxWait = 10000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        const buf = videoChunkBuffers.get(recId);
        if (buf?.complete) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      const buf = videoChunkBuffers.get(recId);
      if (!buf || buf.chunks.length === 0) {
        return formatResult({ error: "No video data received. Recording may have failed." });
      }

      const videoData = Buffer.concat(buf.chunks);
      const outName = filename || `${recId}.webm`;
      const outPath = join(VIDEO_DIR, outName);
      writeFileSync(outPath, videoData);
      videoChunkBuffers.delete(recId);
      if (rec) rec.status = "saved";

      let finalPath = outPath;

      if (format && format !== "webm") {
        try {
          await requireFfmpeg();
          const convertedPath = join(VIDEO_DIR, `${basename(outName, ".webm")}.${format}`);
          await execAsync("ffmpeg", ["-i", outPath, "-y", convertedPath], { timeout: 120000 });
          finalPath = convertedPath;
          try { unlinkSync(outPath); } catch {}
        } catch (e) {
          return formatResult({
            warning: `Saved as WebM but format conversion to ${format} failed: ${e.message}`,
            filePath: outPath,
            size_bytes: videoData.length,
          });
        }
      }

      try {
        await requireFfmpeg();
        const info = await getVideoInfo(finalPath);
        return formatResult(info);
      } catch {
        return formatResult({
          filePath: finalPath,
          size_bytes: videoData.length,
          durationMs: rec ? Date.now() - rec.startedAt : null,
        });
      }
    }
  );

  server.tool(
    "video_record_pause",
    "Pause the current recording. Use video_record_resume to continue.",
    {
      recordingId: z.string().optional().describe("Recording ID (default: most recent)"),
    },
    async ({ recordingId }) => {
      const result = await sendCommand("recording_pause", { recordingId }, 5000);
      const rec = [...activeRecordings.values()].find((r) => r.status === "recording");
      if (rec) rec.status = "paused";
      return formatResult(result?.success ? { status: "paused" } : { error: result?.error || "Failed to pause" });
    }
  );

  server.tool(
    "video_record_resume",
    "Resume a paused recording.",
    {
      recordingId: z.string().optional().describe("Recording ID (default: most recent)"),
    },
    async ({ recordingId }) => {
      const result = await sendCommand("recording_resume", { recordingId }, 5000);
      const rec = [...activeRecordings.values()].find((r) => r.status === "paused");
      if (rec) rec.status = "recording";
      return formatResult(result?.success ? { status: "recording" } : { error: result?.error || "Failed to resume" });
    }
  );

  server.tool(
    "video_record_status",
    "Get the status of active and recent recordings including duration, file size, and state.",
    {
      recordingId: z.string().optional().describe("Specific recording ID to check"),
    },
    async ({ recordingId }) => {
      if (recordingId) {
        const rec = activeRecordings.get(recordingId);
        const buf = videoChunkBuffers.get(recordingId);
        return formatResult({
          recordingId,
          status: rec?.status || "unknown",
          elapsedMs: rec ? Date.now() - rec.startedAt : null,
          chunksReceived: buf?.chunks?.length || 0,
          bytesReceived: buf?.chunks?.reduce((sum, c) => sum + c.length, 0) || 0,
        });
      }

      const recordings = [...activeRecordings.entries()].map(([id, rec]) => {
        const buf = videoChunkBuffers.get(id);
        return {
          recordingId: id,
          status: rec.status,
          elapsedMs: Date.now() - rec.startedAt,
          chunksReceived: buf?.chunks?.length || 0,
        };
      });
      return formatResult({ recordings });
    }
  );

  // --- Video Editing Tools ---

  server.tool(
    "video_info",
    "Get detailed metadata about a video file: duration, resolution, codec, bitrate, frame rate, audio channels, and format.",
    {
      filePath: z.string().describe("Path to the video file, or a recording ID"),
    },
    async ({ filePath }) => {
      await requireFfmpeg();
      const resolved = resolveVideoPath(filePath);
      if (!existsSync(resolved)) return formatResult({ error: `File not found: ${filePath}` });
      return formatResult(await getVideoInfo(resolved));
    }
  );

  server.tool(
    "video_trim",
    "Trim a video to a specific time range. Creates a new file with the trimmed content.",
    {
      filePath: z.string().describe("Path to the video file"),
      startTime: z.string().describe("Start time (e.g. '00:00:05' or '5.0')"),
      endTime: z.string().optional().describe("End time (omit to trim to end)"),
      duration: z.string().optional().describe("Duration instead of end time"),
      output: z.string().optional().describe("Output file path"),
    },
    async ({ filePath, startTime, endTime, duration, output }) => {
      await requireFfmpeg();
      const resolved = resolveVideoPath(filePath);
      if (!existsSync(resolved)) return formatResult({ error: `File not found: ${filePath}` });

      const outPath = output || genOutputPath(resolved, "trimmed");
      const args = ["-i", resolved, "-ss", startTime];
      if (endTime) args.push("-to", endTime);
      else if (duration) args.push("-t", duration);
      args.push("-c", "copy", "-y", outPath);

      await execAsync("ffmpeg", args, { timeout: 60000 });
      return formatResult(await getVideoInfo(outPath));
    }
  );

  server.tool(
    "video_crop",
    "Crop a video to a specific region. Useful for isolating a portion of a screen recording.",
    {
      filePath: z.string().describe("Path to the video file"),
      x: z.number().describe("Left offset in pixels"),
      y: z.number().describe("Top offset in pixels"),
      width: z.number().describe("Crop width in pixels"),
      height: z.number().describe("Crop height in pixels"),
      output: z.string().optional().describe("Output file path"),
    },
    async ({ filePath, x, y, width, height, output }) => {
      await requireFfmpeg();
      const resolved = resolveVideoPath(filePath);
      if (!existsSync(resolved)) return formatResult({ error: `File not found: ${filePath}` });

      const outPath = output || genOutputPath(resolved, "cropped");
      await execAsync("ffmpeg", [
        "-i", resolved, "-filter:v", `crop=${width}:${height}:${x}:${y}`, "-y", outPath,
      ], { timeout: 120000 });
      return formatResult(await getVideoInfo(outPath));
    }
  );

  server.tool(
    "video_merge",
    "Concatenate multiple video files into a single video. Files should have compatible codecs and resolution.",
    {
      filePaths: z.array(z.string()).min(2).describe("Ordered list of video file paths to concatenate"),
      output: z.string().optional().describe("Output file path"),
      reEncode: z.boolean().optional().describe("Re-encode for compatibility (slower but handles mismatched formats)"),
    },
    async ({ filePaths, output, reEncode }) => {
      await requireFfmpeg();
      const resolved = filePaths.map((p) => resolveVideoPath(p));
      for (const p of resolved) {
        if (!existsSync(p)) return formatResult({ error: `File not found: ${p}` });
      }

      const listFile = join(VIDEO_DIR, `concat_${genId()}.txt`);
      const listContent = resolved.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
      writeFileSync(listFile, listContent);

      const outPath = output || genOutputPath(resolved[0], "merged");
      const args = ["-f", "concat", "-safe", "0", "-i", listFile];
      if (reEncode) {
        args.push("-y", outPath);
      } else {
        args.push("-c", "copy", "-y", outPath);
      }

      try {
        await execAsync("ffmpeg", args, { timeout: 300000 });
        return formatResult(await getVideoInfo(outPath));
      } finally {
        try { unlinkSync(listFile); } catch {}
      }
    }
  );

  server.tool(
    "video_add_text",
    "Add text overlay to a video. Supports positioning, font size, color, and timing.",
    {
      filePath: z.string().describe("Path to the video file"),
      text: z.string().describe("Text to overlay"),
      x: z.union([z.number(), z.string()]).optional().describe("X position or expression (default: '(w-text_w)/2')"),
      y: z.union([z.number(), z.string()]).optional().describe("Y position or expression (default: '(h-text_h)/2')"),
      fontSize: z.number().optional().describe("Font size (default: 24)"),
      fontColor: z.string().optional().describe("Font color (default: 'white')"),
      backgroundColor: z.string().optional().describe("Background color behind text (e.g. 'black@0.5')"),
      startTime: z.number().optional().describe("Show text starting at this second"),
      endTime: z.number().optional().describe("Hide text after this second"),
      output: z.string().optional().describe("Output file path"),
    },
    async ({ filePath, text, x, y, fontSize, fontColor, backgroundColor, startTime, endTime, output }) => {
      await requireFfmpeg();
      const resolved = resolveVideoPath(filePath);
      if (!existsSync(resolved)) return formatResult({ error: `File not found: ${filePath}` });

      const safeText = text.replace(/'/g, "'\\\\\\''").replace(/:/g, "\\:");
      let filter = `drawtext=text='${safeText}'`;
      filter += `:x=${x ?? "(w-text_w)/2"}`;
      filter += `:y=${y ?? "(h-text_h)/2"}`;
      filter += `:fontsize=${fontSize || 24}`;
      filter += `:fontcolor=${fontColor || "white"}`;
      if (backgroundColor) filter += `:box=1:boxcolor=${backgroundColor}:boxborderw=5`;
      if (startTime !== undefined && endTime !== undefined) {
        filter += `:enable='between(t,${startTime},${endTime})'`;
      } else if (startTime !== undefined) {
        filter += `:enable='gte(t,${startTime})'`;
      } else if (endTime !== undefined) {
        filter += `:enable='lte(t,${endTime})'`;
      }

      const outPath = output || genOutputPath(resolved, "text");
      await execAsync("ffmpeg", ["-i", resolved, "-vf", filter, "-y", outPath], { timeout: 120000 });
      return formatResult(await getVideoInfo(outPath));
    }
  );

  server.tool(
    "video_add_image_overlay",
    "Add an image overlay (watermark, logo) to a video at a specified position.",
    {
      filePath: z.string().describe("Path to the video file"),
      imagePath: z.string().describe("Path to PNG/JPG image to overlay"),
      x: z.union([z.number(), z.string()]).optional().describe("X position (default: 10)"),
      y: z.union([z.number(), z.string()]).optional().describe("Y position (default: 10)"),
      scale: z.string().optional().describe("Scale the overlay (e.g. '100:100' or 'iw/4:ih/4')"),
      opacity: z.number().optional().describe("Overlay opacity 0.0-1.0"),
      output: z.string().optional().describe("Output file path"),
    },
    async ({ filePath, imagePath, x, y, scale, opacity, output }) => {
      await requireFfmpeg();
      const resolved = resolveVideoPath(filePath);
      if (!existsSync(resolved)) return formatResult({ error: `Video not found: ${filePath}` });
      if (!existsSync(imagePath)) return formatResult({ error: `Image not found: ${imagePath}` });

      let filterComplex;
      if (scale) {
        filterComplex = `[1:v]scale=${scale}[ovr];[0:v][ovr]overlay=${x ?? 10}:${y ?? 10}`;
      } else {
        filterComplex = `[0:v][1:v]overlay=${x ?? 10}:${y ?? 10}`;
      }
      if (opacity !== undefined) {
        filterComplex = `[1:v]format=rgba,colorchannelmixer=aa=${opacity}${scale ? `,scale=${scale}` : ""}[ovr];[0:v][ovr]overlay=${x ?? 10}:${y ?? 10}`;
      }

      const outPath = output || genOutputPath(resolved, "overlay");
      await execAsync("ffmpeg", [
        "-i", resolved, "-i", imagePath, "-filter_complex", filterComplex, "-y", outPath,
      ], { timeout: 120000 });
      return formatResult(await getVideoInfo(outPath));
    }
  );

  const QUALITY_PRESETS = {
    low: { crf: "32", preset: "faster" },
    medium: { crf: "23", preset: "medium" },
    high: { crf: "18", preset: "slow" },
    lossless: { crf: "0", preset: "veryslow" },
  };

  server.tool(
    "video_convert",
    "Convert a video file to a different format (e.g., WebM to MP4, MP4 to GIF). Supports codec and quality options.",
    {
      filePath: z.string().describe("Path to the video file"),
      format: z.enum(["mp4", "webm", "gif", "avi", "mov", "mkv"]).describe("Output format"),
      videoCodec: z.string().optional().describe("Video codec (e.g. 'libx264', 'libvpx-vp9')"),
      audioCodec: z.string().optional().describe("Audio codec (e.g. 'aac', 'libopus')"),
      quality: z.enum(["low", "medium", "high", "lossless"]).optional().describe("Quality preset (default: medium)"),
      resolution: z.string().optional().describe("Output resolution (e.g. '1280x720')"),
      output: z.string().optional().describe("Output file path"),
    },
    async ({ filePath, format, videoCodec, audioCodec, quality, resolution, output }) => {
      await requireFfmpeg();
      const resolved = resolveVideoPath(filePath);
      if (!existsSync(resolved)) return formatResult({ error: `File not found: ${filePath}` });

      const outPath = output || genOutputPath(resolved, "converted", `.${format}`);
      const args = ["-i", resolved];

      if (format === "gif") {
        const scale = resolution ? resolution.split("x")[0] : "480";
        args.push("-filter_complex", `[0:v]fps=10,scale=${scale}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`);
      } else {
        const preset = QUALITY_PRESETS[quality || "medium"];
        if (videoCodec) {
          args.push("-c:v", videoCodec);
        } else if (format === "mp4") {
          args.push("-c:v", "libx264", "-crf", preset.crf, "-preset", preset.preset);
        } else if (format === "webm") {
          args.push("-c:v", "libvpx-vp9", "-crf", preset.crf, "-b:v", "0");
        }

        if (audioCodec) {
          args.push("-c:a", audioCodec);
        } else if (format === "mp4") {
          args.push("-c:a", "aac");
        } else if (format === "webm") {
          args.push("-c:a", "libopus");
        }

        if (resolution) {
          const [w, h] = resolution.split("x");
          args.push("-vf", `scale=${w}:${h}`);
        }
      }

      args.push("-y", outPath);
      await execAsync("ffmpeg", args, { timeout: 300000 });
      return formatResult(await getVideoInfo(outPath));
    }
  );

  server.tool(
    "video_extract_audio",
    "Extract the audio track from a video file as a separate audio file.",
    {
      filePath: z.string().describe("Path to the video file"),
      format: z.enum(["mp3", "wav", "aac", "ogg", "flac"]).optional().describe("Audio format (default: mp3)"),
      output: z.string().optional().describe("Output file path"),
    },
    async ({ filePath, format, output }) => {
      await requireFfmpeg();
      const resolved = resolveVideoPath(filePath);
      if (!existsSync(resolved)) return formatResult({ error: `File not found: ${filePath}` });

      const fmt = format || "mp3";
      const outPath = output || genOutputPath(resolved, "audio", `.${fmt}`);
      const codecMap = { mp3: "libmp3lame", wav: "pcm_s16le", aac: "aac", ogg: "libvorbis", flac: "flac" };

      await execAsync("ffmpeg", [
        "-i", resolved, "-vn", "-acodec", codecMap[fmt] || fmt, "-y", outPath,
      ], { timeout: 120000 });

      return formatResult({
        filePath: outPath,
        format: fmt,
        size_bytes: statSync(outPath).size,
      });
    }
  );

  server.tool(
    "video_extract_frame",
    "Extract a single frame from a video as an image. Useful for creating thumbnails or inspecting specific moments.",
    {
      filePath: z.string().describe("Path to the video file"),
      time: z.string().describe("Timestamp to extract frame from (e.g. '00:00:05' or '5.0')"),
      output: z.string().optional().describe("Output file path"),
      format: z.enum(["png", "jpg"]).optional().describe("Image format (default: png)"),
    },
    async ({ filePath, time, output, format }) => {
      await requireFfmpeg();
      const resolved = resolveVideoPath(filePath);
      if (!existsSync(resolved)) return formatResult({ error: `File not found: ${filePath}` });

      const fmt = format || "png";
      const outPath = output || genOutputPath(resolved, `frame_${time.replace(/:/g, "-")}`, `.${fmt}`);

      await execAsync("ffmpeg", [
        "-i", resolved, "-ss", time, "-frames:v", "1", "-y", outPath,
      ], { timeout: 15000 });

      const data = readFileSync(outPath).toString("base64");
      const mimeType = fmt === "png" ? "image/png" : "image/jpeg";
      return { content: [{ type: "image", data, mimeType }] };
    }
  );

  // --- Video Extraction Tools ---

  server.tool(
    "video_detect_on_page",
    "Detect all video and audio elements on the current page. Returns source URLs, dimensions, duration, format, and playback state for each element.",
    {},
    async () => {
      const result = await sendCommand("detect_videos", {}, 10000);
      if (!result?.success) {
        return formatResult({ error: result?.error || "Failed to detect videos" });
      }
      return formatResult(result.data);
    }
  );

  server.tool(
    "video_extract_sources",
    "Deep-scan the current page for all video sources. Monitors network requests for video MIME types, inspects blob URLs, and detects HLS/DASH streaming manifests. More thorough than video_detect_on_page.",
    {
      durationMs: z.number().optional().describe("How long to monitor network traffic in ms (default: 5000)"),
      includeAudio: z.boolean().optional().describe("Include audio-only sources (default: true)"),
    },
    async ({ durationMs, includeAudio }) => {
      const timeout = (durationMs || 5000) + 5000;
      const result = await sendCommand("extract_video_sources", { durationMs, includeAudio }, timeout);
      if (!result?.success) {
        return formatResult({ error: result?.error || "Failed to extract video sources" });
      }
      return formatResult(result.data);
    }
  );

  server.tool(
    "video_download_from_page",
    "Download a video from the current page by URL or by selecting a detected video element. For direct URLs, uses the Chrome downloads API.",
    {
      url: z.string().optional().describe("Direct video URL to download"),
      selector: z.string().optional().describe("CSS selector for the video element to extract src from"),
      filename: z.string().optional().describe("Output filename"),
      format: z.string().optional().describe("Convert to this format after download (e.g. 'mp4')"),
    },
    async ({ url, selector, filename, format }) => {
      let downloadUrl = url;

      if (!downloadUrl && selector) {
        const srcResult = await sendCommand("execute_js", {
          code: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el?.src || el?.currentSrc || null; })()`,
        }, 5000);
        if (srcResult?.success && srcResult.data) {
          downloadUrl = srcResult.data;
        } else {
          return formatResult({ error: `Could not extract video URL from selector: ${selector}` });
        }
      }

      if (!downloadUrl) {
        return formatResult({ error: "Provide either a url or a selector to download from" });
      }

      const outName = filename || `download_${genId()}${extname(downloadUrl).split("?")[0] || ".mp4"}`;
      const outPath = join(VIDEO_DIR, outName);

      const dlResult = await sendCommand("trigger_download", {
        url: downloadUrl,
        filename: outName,
        saveAs: false,
      }, 60000);

      if (!dlResult?.success) {
        return formatResult({ error: dlResult?.error || "Download failed" });
      }

      if (format) {
        try {
          await requireFfmpeg();
          const convertedPath = join(VIDEO_DIR, `${basename(outName, extname(outName))}.${format}`);
          await execAsync("ffmpeg", ["-i", outPath, "-y", convertedPath], { timeout: 120000 });
          return formatResult({ filePath: convertedPath, format, originalUrl: downloadUrl });
        } catch (e) {
          return formatResult({ filePath: outPath, warning: `Conversion failed: ${e.message}`, originalUrl: downloadUrl });
        }
      }

      return formatResult({ filePath: outPath, originalUrl: downloadUrl, downloadId: dlResult.data?.downloadId });
    }
  );

  // --- File Management Tools ---

  server.tool(
    "video_list_files",
    "List all video files in the working directory with their sizes, durations, and creation times.",
    {
      directory: z.string().optional().describe("Directory to list (default: video working directory)"),
    },
    async ({ directory }) => {
      const dir = directory || VIDEO_DIR;
      if (!existsSync(dir)) return formatResult({ error: `Directory not found: ${dir}` });

      const videoExts = new Set([".mp4", ".webm", ".mkv", ".avi", ".mov", ".gif", ".mp3", ".wav", ".aac", ".ogg", ".flac"]);
      const files = readdirSync(dir)
        .filter((f) => videoExts.has(extname(f).toLowerCase()))
        .map((f) => {
          const fullPath = join(dir, f);
          const stat = statSync(fullPath);
          return {
            name: f,
            path: fullPath,
            size_bytes: stat.size,
            created: stat.birthtime.toISOString(),
            modified: stat.mtime.toISOString(),
          };
        })
        .sort((a, b) => new Date(b.modified) - new Date(a.modified));

      return formatResult({ directory: dir, count: files.length, files });
    }
  );

  server.tool(
    "video_delete_file",
    "Delete a video file from the working directory.",
    {
      filePath: z.string().describe("Path or filename of the video file to delete"),
    },
    async ({ filePath }) => {
      const resolved = resolveVideoPath(filePath);
      if (!existsSync(resolved)) return formatResult({ error: `File not found: ${filePath}` });

      const realDir = join(resolved, "..");
      if (realDir !== VIDEO_DIR && !resolved.startsWith(VIDEO_DIR)) {
        return formatResult({ error: "Can only delete files within the video working directory" });
      }

      unlinkSync(resolved);
      return formatResult({ deleted: resolved });
    }
  );
}
