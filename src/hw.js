// Device capability detection.
export async function detectHardware() {
  const hw = {
    webgpu: false, f16: false, gpuName: '', maxBufferMB: 0,
    memGB: navigator.deviceMemory || null, // Chromium only, capped at 8
    cores: navigator.hardwareConcurrency || 4,
    isolated: !!self.crossOriginIsolated,
    storageQuota: null, storageUsed: null,
    mobile: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent),
  };
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        hw.webgpu = true;
        hw.f16 = adapter.features.has('shader-f16');
        hw.maxBufferMB = Math.round((adapter.limits.maxBufferSize || 0) / 1048576);
        const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
        hw.gpuName = [info.vendor, info.architecture || info.description].filter(Boolean).join(' ');
      }
    }
  } catch { /* no WebGPU */ }
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) { hw.storageQuota = est.quota; hw.storageUsed = est.usage; }
  } catch { /* ignore */ }
  return hw;
}

// Rough fit estimate. Browsers do not expose VRAM, so this is a heuristic.
// Returns 'ok' | 'tight' | 'no'.
export function fitFor(hw, needMB, kind) {
  const ramMB = (hw.memGB || (hw.mobile ? 4 : 8)) * 1024;
  if (kind === 'gpu') {
    if (!hw.webgpu) return 'no';
    // integrated/mobile GPUs share system RAM; leave headroom for the OS and browser
    const budget = ramMB * (hw.mobile ? 0.35 : 0.55);
    if (needMB <= budget * 0.7) return 'ok';
    if (needMB <= budget) return 'tight';
    return 'no';
  }
  const budget = ramMB * (hw.mobile ? 0.3 : 0.5);
  const need = needMB * 1.25; // weights + KV cache + runtime
  if (need <= budget * 0.7) return 'ok';
  if (need <= budget) return 'tight';
  return 'no';
}
