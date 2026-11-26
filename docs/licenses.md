# Licenses: models, dataset, and libraries

Recompute only uses openly licensed models and data. The Hub downloads each model **once** from Hugging Face at a fixed version (a pinned commit), checks its SHA-256 fingerprint, and serves it to devices over the local network. If a file doesn't match its fingerprint, it's rejected. The pins live in `hub/src/config.ts`.

## AI models
| Model | Used for | License | Source (pinned) | SHA-256 |
|---|---|---|---|---|
| MobileNetV3-Large 100 (`mobilenetv3_large_100.ra_in1k`, ONNX) | Swarm Sort labels; Teach the Swarm features | Apache-2.0 | [onnx-community/mobilenetv3_large_100.ra_in1k](https://huggingface.co/onnx-community/mobilenetv3_large_100.ra_in1k) @ `ded3e24c` | `a88a7545cb3fbafffeb6f09140d56c88f73cebf6a892cd80cf8c5ce4f2a0293d` |
| SmolLM2-360M-Instruct, GGUF Q8_0 | Private Tutor (default) | Apache-2.0 | [HuggingFaceTB/SmolLM2-360M-Instruct-GGUF](https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF) @ `593b5a2e` | `48ab3034d0dd401fbc721eb1df3217902fee7dab9078992d66431f09b7750201` |
| Qwen2.5-0.5B-Instruct, GGUF Q4_K_M (optional) | Private Tutor (second choice) | Apache-2.0 | [Qwen/Qwen2.5-0.5B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF) @ `9217f5db` | `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db` |

How the models are changed:
- **MobileNetV3:** the Hub adds one extra output to the ONNX graph (the 1,280-number "features" layer just before the classifier) so Teach the Swarm can reuse the same file. The weights aren't changed. The class names come from the model's own `config.json`, which is the ImageNet-1k label list.
- **SmolLM2 and Qwen:** used unchanged.

The models were trained by their authors on their own datasets (e.g. ImageNet-1k for MobileNetV3). Recompute doesn't redistribute any training data.

## Swarm Sort image set
- **Source:** Caltech 101. Li, F.-F., Andreeto, M., Ranzato, M., & Perona, P. (2022). *Caltech 101* (Version 1.0). CaltechDATA. https://doi.org/10.22002/D1.20086
- **License:** Creative Commons Attribution 4.0 (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/
- **Changes made:** a subset of 1,000 images across 97 categories. Each image was resized (shortest edge 256 px), center-cropped to 224×224, and re-saved as JPEG (quality 85). The details are in `data/swarmsort/manifest.json`.
- **Attribution:** if you show these images in a presentation or publication, credit "Images: Caltech 101 (Li, Andreeto, Ranzato, Perona), CC BY 4.0".

## Teach the Swarm photos
Those photos are taken by the user on each device. They stay on that device, and Recompute never uploads them.

## Software libraries
| Library | Version | License | Used for |
|---|---|---|---|
| onnxruntime-web | 1.31.1 | MIT | Running MobileNetV3 in the browser (WASM, optional WebGPU) |
| @wllama/wllama (+ wllama-compat) | 4.0.0 | MIT | Running the GGUF tutor models in the browser (llama.cpp compiled to WASM) |
| ws | 8.23.0 | MIT | WebSockets on the Hub |
| qrcode | 1.5.4 | MIT | Join QR codes |
| node-forge | 1.4.4 | BSD-3-Clause OR GPL-2.0 (BSD chosen) | Making the local certificate authority and the Hub's certificate |
| protobufjs | 8.8.1 | BSD-3-Clause | Adding the features output to the ONNX file |
| esbuild | 0.28.2 | MIT | Bundling the web pages |
| tsx | 4.23.15 | MIT | Running the TypeScript Hub |
| playwright (dev only) | 1.65.1 | Apache-2.0 | Automated multi-device tests |
| typescript (dev only) | 7.0.2 | Apache-2.0 | Type checking |

Also built in: Node.js `node:sqlite` (Node.js license, MIT) for the Hub's database.

## This project
Recompute's own code is MIT licensed (see `package.json`).

## Speech models (live captions and English→Spanish)
The Hub downloads these once from Hugging Face at a pinned revision, checks every file's sha256 (pins are in `hub/src/config.ts`), and serves them over the LAN at `/models/<id>/<file>`.

| Model | Source (pinned revision) | License | Files |
|---|---|---|---|
| whisper-tiny-en | [onnx-community/whisper-tiny.en](https://huggingface.co/onnx-community/whisper-tiny.en) @ `794207fec2761281fe63a23a94b7e9f53a4efbc1`, an ONNX export of [openai/whisper-tiny.en](https://huggingface.co/openai/whisper-tiny.en) | Apache-2.0 (model card). The original Whisper code is MIT. | int8 encoder + merged decoder + configs/tokenizer, ≈ 43.5 MB |
| opus-mt-en-es | [Xenova/opus-mt-en-es](https://huggingface.co/Xenova/opus-mt-en-es) @ `4b002a4c7edd54a7ced58877258b87f7efd3f892`, an ONNX export of [Helsinki-NLP/opus-mt-en-es](https://huggingface.co/Helsinki-NLP/opus-mt-en-es) | CC-BY-4.0. The Helsinki-NLP OPUS-MT-train README releases the trained models under CC-BY 4.0. The HF model card tag says Apache-2.0. We follow the stricter of the two: attribution required. | int8 encoder + merged decoder + configs/tokenizer, ≈ 119.6 MB |

- **Attribution for OPUS-MT:** "Translation: OPUS-MT (Tiedemann & Thottingal, 2020; Helsinki-NLP), CC BY 4.0".
- **OPUS-MT training data:** the training corpora (OPUS) and Tatoeba data carry their own licenses (for example, Tatoeba-Challenge data is CC-BY-NC-SA 4.0). We redistribute only the trained model, not that data.
- **Sample clip:** `data/speech/sample-en.wav` was synthesized with macOS text-to-speech (`say -v Samantha`) from our own sentence, stored in `data/speech/sample-en.json`. It contains no recorded voices.

| Library | Version | License | Used for |
|---|---|---|---|
| @huggingface/transformers (Transformers.js) | 4.3.2 | Apache-2.0 | Whisper and OPUS-MT in the speech worker |
| onnxruntime-web (Transformers.js's own copy, served at `/vendor/ort-tjs/`) | 1.31.0-dev.20260914-8d85527a0 | MIT | WASM runtime for the speech models |
