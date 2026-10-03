// Runs the image-recognition model (MobileCLIP S0, via Transformers.js) off the
// main thread so the page stays smooth. Receives image blobs, returns
// normalized 512-number "embeddings" that describe what each image looks like.
import { AutoProcessor, CLIPVisionModelWithProjection, RawImage, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';

env.allowLocalModels = false; // always fetch from the Hugging Face hub (cached by the browser afterwards)

const MODEL = 'Xenova/mobileclip_s0';
let ready;

function load() {
  ready ??= (async () => {
    const progress = p => {
      if (p.status === 'progress') postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    };
    const processor = await AutoProcessor.from_pretrained(MODEL);
    // Half precision is a 23 MB download. (The 8-bit version gives wrong results, so it's not used.)
    let model;
    try {
      model = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: 'fp16', device: 'wasm', progress_callback: progress });
    } catch {
      model = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: 'fp32', device: 'wasm', progress_callback: progress });
    }
    return { processor, model };
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    const { processor, model } = await load();
    if (type === 'init') {
      postMessage({ id, ok: true });
    } else if (type === 'embed') {
      const image = await RawImage.fromBlob(data.blob);
      const { image_embeds } = await model(await processor(image));
      const vec = Float32Array.from(image_embeds.normalize().tolist()[0]);
      postMessage({ id, vec }, [vec.buffer]);
    }
  } catch (e) {
    postMessage({ id, error: String(e?.message || e) });
  }
};
