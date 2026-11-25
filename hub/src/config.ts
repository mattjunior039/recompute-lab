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
  kind: 'onnx' | 'gguf';
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
