---
name: image-generation
version: 1.0.0
description: Generate a local mockup, wireframe or visual-exploration image with Qwen-Image-2.1 through stable-diffusion.cpp, and report it as a generated illustration, never as evidence. Load when a design discussion would be clearer with a picture and the machine has the model configured. Do NOT use to show what an implementation actually looks like — that is a screenshot of the running app — or for video and animation, which is `motion-graphics`.
---

# Image Generation

## What it is for

A generated image is an **illustration of an idea**, useful to make a proposed
layout, flow step or visual direction concrete enough to argue about. It is not
evidence of anything:

- It does not show what the product looks like — a screenshot of the running app does.
- It does not validate a design — users, research or a prototype do.
- It will contain invented text, controls and data. Nobody may read it as a spec.

Every image you produce is labelled **generated** wherever it is referenced, with
the prompt beside it, so a reader can tell it apart from a capture.

Good uses: a low-fidelity wireframe of two competing layouts, an empty-state
illustration direction, a mood reference for a visual refresh. Bad uses: "here is
the new settings page" when no settings page has been built; anything shipped to
users without a human pass.

## Running it

Write the prompt to a file, then pass the file:

```
python <this skill's directory>/generate.py --prompt-file <relative/prompt.txt> --out <relative/path.png> [--width 1024 --height 1024 --steps 20 --seed 42]
```

Use `--prompt-file`, not `--prompt "..."`, whenever any part of the prompt came
from text you did not write yourself, such as a ticket, a brief or a document,
and always in a handed-off command. Inside double quotes a shell expands `$(...)`
and backticks before the script ever runs. The script's own argv list only
protects the step after it.

- `--out` must be inside the current working directory and end in `.png`. The
  script refuses to overwrite an existing file unless `--force` is passed.
- Width and height are multiples of 16 between 256 and 2048. Start at 512×512
  while exploring. It was measured at 36 s per 512×512 image on a 6 GB GPU with
  weights offloaded to RAM. Larger sizes cost proportionally more.
- Success is the final line `OK <absolute path> <width>x<height>`, printed only
  after the PNG has been read back from disk at the requested size. Anything else
  exits nonzero. Report the failure as a failure. Do not describe an image you
  did not get.

If the script says it is not configured, stop and report which variables are
missing. Do not try to download or install anything yourself.

On a small GPU the render competes with any local LLM that is loaded. This was
measured with Qwen3.8-27B held by Ollama on a 6 GB card: sd-cli ran out of device
memory and exited 1, once during sampling and once while encoding the prompt. If that happens, report it as a
failure and say a local model was loaded. Unloading that model is the human's
decision, so do not stop another process yourself. If you are running *on* that
local model, the image cannot render until your own session ends.

## Prompting for mockups

Name the fidelity and the medium first, then the structure, then the content:
`low-fidelity greyscale wireframe, desktop web app, left sidebar navigation, main
area with a table of 5 rows and a primary button top right, placeholder text`.
Ask for placeholder text. Real-looking copy in a mockup gets quoted as if it
were decided. Keep one idea per image, since two variants belong in two images
with the same seed.

## Setup (one-time, by a human)

On Windows `SD_CPP_BIN` must be the `.exe` itself, not a `.bat`/`.cmd` wrapper:
cmd.exe re-parses a batch file's command line, which would turn shell
characters in a prompt into commands, so the script refuses one.

The four environment variables the script reads:

| Variable | File | Source |
|---|---|---|
| `SD_CPP_BIN` | `sd-cli` (`sd-cli.exe` on Windows) | stable-diffusion.cpp release `master-920-2f88688` (verified here), or any later one; CUDA/Vulkan/CPU as the machine allows |
| `QWEN_IMAGE_DIFFUSION_MODEL` | `qwen_image_2.1-Q4_K.gguf` | `huggingface.co/leejet/Qwen-Image-2.1-GGUF` |
| `QWEN_IMAGE_LLM` | `Qwen3VL-8B-Instruct-Q4_K_M.gguf` | `huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF` |
| `QWEN_IMAGE_VAE` | `qwen_image_2.1_vae_bf16.safetensors` | `huggingface.co/Comfy-Org/Qwen-Image-2.1` (`vae/`) |

SHA-256 of the files this skill was verified with (2026-09-26). Check yours
against them, because the Hugging Face paths above point at `main`, which can
move:

| File | SHA-256 |
|---|---|
| `sd-master-2f88688-bin-win-cuda12-x64.zip` | `479133a03d5c861ce77e70354dbbe75dd6e8d9955d1d1c7b6b1456b4571e3039` |
| `qwen_image_2.1-Q4_K.gguf` | `29f9c83c249ff0292fb2943fceddfa2319b446601866c82a4f8be062abea72c2` |
| `Qwen3VL-8B-Instruct-Q4_K_M.gguf` | `67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2` |
| `qwen_image_2.1_vae_bf16.safetensors` | `bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9` |

The flags the script passes follow stable-diffusion.cpp's
`docs/qwen_image_2.1.md`, including `--offload-to-cpu`, which is what lets it
run on a GPU with less memory than the weights.

## Reporting

Report every image in one line: `Generated images: <path> ("<prompt>") | none`.
Write `none` when you generated nothing. If generation failed, write
`failed: <error line>`. If you have no shell, write the prompt file yourself
and hand your caller the command, which then contains only paths and numbers.
Report it as `handed off: <command>` so the caller knows an image is still owed.
