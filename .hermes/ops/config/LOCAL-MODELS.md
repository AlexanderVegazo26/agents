# Local models — Hermes setup

Updated: 2026-10-13. All local inference goes through **LlamaStash**. The old
hand-run `llama-server` processes, socat bridges, `llama-router.service` and the
Docker `llama-vulkan` (ai-server compose, Qwen3.8 on :8080 — stopped, restart=no)
are retired.

## Single entry point

- Proxy: `http://127.0.0.1:11435/v1` (bearer key: `llamastash api-key`)
- Managed by `llamastash.service` (systemd --user). Models are managed launches;
  the proxy auto-starts on request and unloads after 30 min idle.

## The working set: brain + eyes + ears

These three run together (~54 GiB of the 96 GiB carve-out, ~42 GiB headroom):

| role | alias | proxy model id | engine | memory | notes |
|---|---|---|---|---|---|
| brain | `ornith` | `Ornith-1.5-35B-Q8_0` | llama.cpp ROCm, MTP | 41 GiB | ctx 131072, ~60 t/s; `model.default`, every cron job, every SDLC tier, MoA aggregator |
| eyes | `vision` | `Qwen3-VL-8B-Instruct-Q8_0` | llama.cpp ROCm + mmproj | 15 GiB | preset `vision`, ctx 32768, ~25 t/s; `auxiliary.vision` |
| ears | — | `whisper` | whisper.cpp ROCm / faster-whisper CPU | ~1.6 GiB while transcribing | see Speech-to-text below |

Verified end to end 2026-10-13: a 2-min video → whisper SRT + 8 VL frame captions
in parallel (31 s) → Ornith summary + chapters (13 s); peak 55.4 GiB.

**Images:** Ornith is text-only. `agent.image_input_mode: text` + `auxiliary.vision`
(Qwen3-VL) make Hermes describe every attached image first and hand Ornith the text.

## Other models (on demand, mind the budget)

| alias | proxy model id | memory | fits beside the working set? |
|---|---|---|---|
| `fast` / `stash-coder` | `Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL` | ~20 GiB | yes (~75 GiB total) |
| `qwen38` / `stash-qwen38` | `Qwen3.8-27B-UD-Q4_K_XL` | ~28 GiB | yes, tight (~82 GiB) |
| `apodex-solo` / `stash-apodex` | `apodex` (Ciru vLLM, ornith-based) | 46 GiB | **no** — stop Ornith + VL first. Was alias `big`. |

## Lifecycle

```bash
systemctl --user restart llamastash      # reload config / presets (unloads everything)
llamastash status                        # launches, ports
llm on <model-id>                        # explicit start (llm off to stop)
```

Presets live in `~/.config/llamastash/config.yaml`.

## VRAM

BIOS carve-out: 96 GiB VRAM, separate from the 30 GiB system RAM. Check real
usage with `rocm-smi --showpids` or `/sys/class/drm/card*/device/mem_info_vram_used`.
The LlamaStash TUI `VRAM` bar reads `used / 111G`: 96 GiB carve-out + 15 GiB GTT
(the GTT part shrinks under RAM pressure). Before the 2026-10-13 patch it showed
`used/used` (e.g. `54/54G`) because it capped the whole pool by free system RAM.

## Known issue

`~/.hermes/scripts/pr_context.sh` exits non-zero when `PR_COUNT=0`
(`set -o pipefail` plus a `grep` that matches nothing), so the `pr-reviewer` cron
job is marked failed on runs with no unreviewed PRs. The model path itself is fine.

## Speech-to-text (`whisper`, updated 2026-10-13)

LlamaStash `generic` server `whisper` wraps `~/.hermes/scripts/whisper-server.py`
(OpenAI-style `/v1/audio/transcriptions`). It is hybrid:

- `json`/`text`/`srt`/`vtt` → **whisper.cpp on the GPU** (`~/AI/engines/whisper.cpp/build-hip`,
  `~/AI/models/whisper-ggml/ggml-large-v3-turbo.bin` + silero VAD): ~35x realtime,
  a 2-min video in ~3.5 s.
- word timings (`verbose_json`, `timestamp_granularities[]=word`) → **faster-whisper
  on the CPU** (int8, 16 threads, ~13x realtime): whisper.cpp's DTW word times ran
  ~0.35 s late, too loose for captions.
- Old CPU-only server: `whisper-server.py.bak-cpu-20261013`.

Notes:
- **2026-10-18: the LlamaStash 0.8.0 proxy has no audio route** (the patch below lived in the
  old 0.6.1 build). `hermes-stt-shim.service` (`~/.hermes/scripts/stt_shim.py`, unit in
  `~/.config/systemd/user/`) listens on `127.0.0.1:11436`, finds the whisper launch's current
  port, starts it if down, and byte-pipes the upload. `stt.openai.base_url` points at it.
  Check: `curl localhost:11436/health`. The note below is the old behaviour.
- Since 2026-10-13 the proxy routes `POST /v1/audio/transcriptions` (and `/translations`)
  — a patch in the `strix-carveout-fixes` build that reads `model` from the multipart
  form. Use `http://127.0.0.1:11435/v1/audio/transcriptions` with the bearer key and
  `model=whisper`: it auto-starts whisper (~4 s cold) and idle-unloads it after 30 min.
  Uploads up to `proxy.max_body_size` = 256 MiB.
- `stt-transcribe [--format srt|vtt|text|verbose_json] AUDIO` (`~/.local/bin`) still
  works: it finds the launch's own port via `llamastash status --json`.
- Hermes voice notes use it: `stt.provider: openai` with `stt.openai.base_url` = the
  proxy, `model: whisper`, `api_key: ${LLAMASTASH_API_KEY}` (from `~/.hermes/.env`).
  Roll back to in-process CPU faster-whisper with `stt.provider: "local"`.
  `stt.language` is `""` (auto-detect) — it was `"en"`, which forced Spanish into English.
