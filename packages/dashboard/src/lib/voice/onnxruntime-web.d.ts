// onnxruntime-web ships types via top-level `"types"`, but its `exports`
// field has no `types` condition — so TypeScript with moduleResolution:"bundler"
// can't resolve them. We only touch `env.wasm.{wasmPaths,numThreads}`; a loose
// ambient declaration is enough to unblock the build.
declare module 'onnxruntime-web';
