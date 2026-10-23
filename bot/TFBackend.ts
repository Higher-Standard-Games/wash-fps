/**
 * TFBackend — TensorFlow.js Backend Abstraction
 *
 * Provides a single import point for TensorFlow.js that:
 *   1. Tries @tensorflow/tfjs-node (native C++ backend, fast)
 *   2. Falls back to @tensorflow/tfjs (WASM/CPU, always works)
 *
 * Usage:
 *   import { initTF, getTF } from './TFBackend';
 *
 * This avoids scattering try/catch dynamic imports throughout the codebase.
 * All bot files that need TF.js should import from here, not directly.
 */

// We use a dynamic resolution approach: try native first, fall back gracefully.
// The resolved module is cached by Node.js after first import.

/** The TensorFlow.js module, whichever package it was loaded from. */
export type TFModule = typeof import("@tensorflow/tfjs-node");

let _tf: TFModule | null = null;
let _backend: "tensorflow" | "cpu" | "wasm" | "none" = "none";
let _initPromise: Promise<void> | null = null;

/**
 * Initialize TensorFlow.js with the best available backend.
 * Safe to call multiple times — only initializes once.
 */
export async function initTF(): Promise<void> {
  if (_tf) return;
  if (_initPromise) return _initPromise;

  _initPromise = _doInit();
  return _initPromise;
}

/**
 * @tensorflow/tfjs-node calls `util.isNullOrUndefined` from Node's own `util`,
 * which Node 23 removed. It looks the function up at each call, so putting it
 * back on the module before the backend runs is enough.
 */
async function restoreNodeUtil(): Promise<void> {
  try {
    const util = (await import("node:util")) as unknown as { default?: Record<string, unknown> } & Record<
      string,
      unknown
    >;
    const target = util.default ?? util;
    if (typeof target.isNullOrUndefined !== "function") {
      target.isNullOrUndefined = (value: unknown) => value === null || value === undefined;
    }
  } catch {
    // Not Node: the native backend is not loadable here either
  }
}

async function _doInit(): Promise<void> {
  // Try 1: Native C++ backend (@tensorflow/tfjs-node)
  try {
    await restoreNodeUtil();
    const mod = await import("@tensorflow/tfjs-node");
    _tf = mod;
    _backend = (mod.getBackend?.() as typeof _backend) || "tensorflow";
    console.log(`[TFBackend] Loaded @tensorflow/tfjs-node (backend: ${_backend})`);
    return;
  } catch {
    console.warn("[TFBackend] @tensorflow/tfjs-node not available, trying pure JS fallback...");
  }

  // Try 2: Pure JS backend (@tensorflow/tfjs — WASM or CPU)
  try {
    const tfjsPackage = "@tensorflow/tfjs";
    const mod = (await import(tfjsPackage)) as unknown as typeof import("@tensorflow/tfjs-node");
    _tf = mod;
    _backend = (mod.getBackend?.() as typeof _backend) || "cpu";
    console.log(`[TFBackend] Loaded @tensorflow/tfjs (backend: ${_backend})`);
    return;
  } catch {
    console.error("[TFBackend] No TensorFlow.js backend available!");
    console.error("[TFBackend] Install with: npm install @tensorflow/tfjs-node");
    _backend = "none";
  }
}

/**
 * Get the initialized TF.js module.
 * Throws if initTF() hasn't been called or failed.
 */
export function getTF(): TFModule {
  if (!_tf) {
    throw new Error("[TFBackend] TensorFlow.js not initialized. Call await initTF() first.");
  }
  return _tf;
}

/** Which backend is active */
export function getBackendName(): string {
  return _backend;
}

/** Whether TF.js is available */
export function isTFAvailable(): boolean {
  return _tf !== null;
}
