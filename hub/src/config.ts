import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA_DIR = process.env.RECOMPUTE_DATA ?? path.join(ROOT, '.recompute');
export const CERT_DIR = path.join(DATA_DIR, 'certs');
export const MODEL_DIR = path.join(DATA_DIR, 'models');
export const DB_PATH = path.join(DATA_DIR, 'recompute.db');
export const WEB_DIR = path.join(ROOT, 'web');
export const DIST_DIR = path.join(WEB_DIR, 'dist');
export const DATASET_DIR = path.join(ROOT, 'data', 'swarmsort');
export const SPEECH_DIR = path.join(ROOT, 'data', 'speech');

export const HTTPS_PORT = Number(process.env.RECOMPUTE_HTTPS_PORT ?? 8443);
export const HTTP_PORT = Number(process.env.RECOMPUTE_HTTP_PORT ?? 8080);

export interface PinnedFile {
  name: string; // file name served at /models/<id>/<name>
  url: string; // where the Hub downloads it once
  sha256: string;
  size: number;
}

export interface PinnedModel {
  id: string;
  title: string;
  kind: 'onnx' | 'gguf' | 'hf'; // hf = a Transformers.js model folder (ONNX + JSON configs), used by the speech worker
  license: string;
  source: string;
  files: PinnedFile[];
  optional?: boolean; // downloaded only when asked (big LLMs)
}

const HF = 'https://huggingface.co';

export const MODELS: PinnedModel[] = [
  {
    id: 'mobilenetv3',
    title: 'MobileNetV3-Large (ImageNet)',
    kind: 'onnx',
    license: 'Apache-2.0',
    source: `${HF}/onnx-community/mobilenetv3_large_100.ra_in1k (base: timm/mobilenetv3_large_100.ra_in1k)`,
    files: [
      {
        name: 'model.onnx',
        url: `${HF}/onnx-community/mobilenetv3_large_100.ra_in1k/resolve/ded3e24c1c5a7972b79cf589903e00353a253217/onnx/model.onnx`,
        sha256: 'a88a7545cb3fbafffeb6f09140d56c88f73cebf6a892cd80cf8c5ce4f2a0293d',
        size: 21949218,
      },
      {
        name: 'config.json',
        url: `${HF}/onnx-community/mobilenetv3_large_100.ra_in1k/resolve/ded3e24c1c5a7972b79cf589903e00353a253217/config.json`,
        sha256: '16409bdf52a18b9e446489acb892caaec6202d62d82302bca96f5edaf559d91d',
        size: 69799,
      },
    ],
  },
  {
    id: 'smollm2-360m',
    title: 'SmolLM2-360M-Instruct (Q8_0)',
    kind: 'gguf',
    license: 'Apache-2.0',
    source: `${HF}/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF`,
    files: [
      {
        name: 'smollm2-360m-instruct-q8_0.gguf',
        url: `${HF}/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF/resolve/593b5a2e04c8f3e4ee880263f93e0bd2901ad47f/smollm2-360m-instruct-q8_0.gguf`,
        sha256: '48ab3034d0dd401fbc721eb1df3217902fee7dab9078992d66431f09b7750201',
        size: 386404992,
      },
    ],
  },
  // Speech (live captions + English→Spanish). Served flat at /models/<id>/<name>; the speech worker
  // maps Transformers.js' `onnx/…` paths onto these names (web/src/workers/speech.ts).
  {
    id: 'whisper-tiny-en',
    title: 'Whisper tiny.en (speech-to-text, int8)',
    kind: 'hf',
    license: 'Apache-2.0',
    source: `${HF}/onnx-community/whisper-tiny.en (base: openai/whisper-tiny.en)`,
    files: [
      { name: 'config.json', url: `${HF}/onnx-community/whisper-tiny.en/resolve/794207fec2761281fe63a23a94b7e9f53a4efbc1/config.json`, sha256: '251ea843b5901a99efa58c0b99b8052c6019aa3e7d2baf46693a1128ff606233', size: 2197 },
      { name: 'generation_config.json', url: `${HF}/onnx-community/whisper-tiny.en/resolve/794207fec2761281fe63a23a94b7e9f53a4efbc1/generation_config.json`, sha256: '7b2e8451ed5f118e75fdd991409d72119d21d2fef1eba9723f68fb9c57fe5dc9', size: 1646 },
      { name: 'preprocessor_config.json', url: `${HF}/onnx-community/whisper-tiny.en/resolve/794207fec2761281fe63a23a94b7e9f53a4efbc1/preprocessor_config.json`, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d', size: 339 },
      { name: 'tokenizer.json', url: `${HF}/onnx-community/whisper-tiny.en/resolve/794207fec2761281fe63a23a94b7e9f53a4efbc1/tokenizer.json`, sha256: '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0', size: 2405679 },
      { name: 'tokenizer_config.json', url: `${HF}/onnx-community/whisper-tiny.en/resolve/794207fec2761281fe63a23a94b7e9f53a4efbc1/tokenizer_config.json`, sha256: '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c', size: 282662 },
      { name: 'encoder_model_quantized.onnx', url: `${HF}/onnx-community/whisper-tiny.en/resolve/794207fec2761281fe63a23a94b7e9f53a4efbc1/onnx/encoder_model_quantized.onnx`, sha256: 'e93ec822f16a8fd264e7de972ad17d615ea7334b75a52d54c50c2e18dd503a25', size: 10124993 },
      { name: 'decoder_model_merged_quantized.onnx', url: `${HF}/onnx-community/whisper-tiny.en/resolve/794207fec2761281fe63a23a94b7e9f53a4efbc1/onnx/decoder_model_merged_quantized.onnx`, sha256: 'c0592d0749413c960569e1c7fb806b060d5d18f3ebad4a95cbf9a77dc6e9be52', size: 30718858 },
    ],
  },
  {
    id: 'opus-mt-en-es',
    title: 'OPUS-MT English→Spanish (translation, int8)',
    kind: 'hf',
    license: 'CC-BY-4.0 (HF card: Apache-2.0)',
    source: `${HF}/Xenova/opus-mt-en-es (base: Helsinki-NLP/opus-mt-en-es)`,
    files: [
      { name: 'config.json', url: `${HF}/Xenova/opus-mt-en-es/resolve/4b002a4c7edd54a7ced58877258b87f7efd3f892/config.json`, sha256: '499eae1f97eeba63172fc884f92fd727ae803b7ceb79c0f653aa4b011152af2f', size: 1468 },
      { name: 'generation_config.json', url: `${HF}/Xenova/opus-mt-en-es/resolve/4b002a4c7edd54a7ced58877258b87f7efd3f892/generation_config.json`, sha256: 'b743baabb7da4c1a2f19fe558bd6b4c0c7c3b0762fcb5ca7a48fe5a2c2219803', size: 293 },
      { name: 'tokenizer.json', url: `${HF}/Xenova/opus-mt-en-es/resolve/4b002a4c7edd54a7ced58877258b87f7efd3f892/tokenizer.json`, sha256: '285eb29e7155ee48851a77960797813f86a125f70d2c1a124f613f1fbd2b19c3', size: 6262682 },
      { name: 'tokenizer_config.json', url: `${HF}/Xenova/opus-mt-en-es/resolve/4b002a4c7edd54a7ced58877258b87f7efd3f892/tokenizer_config.json`, sha256: 'dfb00189b823fb0f15464e9c4e68dd8594f5e5ef5f8dc497468a37741e73aa1f', size: 282 },
      { name: 'encoder_model_quantized.onnx', url: `${HF}/Xenova/opus-mt-en-es/resolve/4b002a4c7edd54a7ced58877258b87f7efd3f892/onnx/encoder_model_quantized.onnx`, sha256: '03434edd1147e6c49e22066e9dc5888235e99cc35a6711d1c4ea5b06455d5da9', size: 52899742 },
      { name: 'decoder_model_merged_quantized.onnx', url: `${HF}/Xenova/opus-mt-en-es/resolve/4b002a4c7edd54a7ced58877258b87f7efd3f892/onnx/decoder_model_merged_quantized.onnx`, sha256: '58ee5ddd6e22d1693d8722b90c1486afb93700a4376cf28fd74175052ad530ae', size: 60212804 },
    ],
  },
  {
    id: 'qwen2.5-0.5b',
    title: 'Qwen2.5-0.5B-Instruct (Q4_K_M)',
    kind: 'gguf',
    license: 'Apache-2.0',
    source: `${HF}/Qwen/Qwen2.5-0.5B-Instruct-GGUF`,
    optional: true,
    files: [
      {
        name: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
        url: `${HF}/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/9217f5db79a29953eb74d5343926648285ec7e67/qwen2.5-0.5b-instruct-q4_k_m.gguf`,
        sha256: '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db',
        size: 491400032,
      },
    ],
  },
];
