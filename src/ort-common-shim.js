// transformers.web.js imports `Tensor` from "onnxruntime-common". The ORT web
// bundle already contains its own copy of onnxruntime-common, so re-export from
// it to make sure both sides share the exact same Tensor class.
export * from '../node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs';
