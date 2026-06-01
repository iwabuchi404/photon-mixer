/**
 * WebGPU型定義
 * TypeScript 5.4以降では DOM API の型が自動的に含まれるはずですが、
 * 必要に応じてこのファイルで型を宣言します
 */

// WebGPU APIはグローバルに定義されているため、拡張宣言
declare global {
  interface Navigator {
    gpu: GPU;
  }

  interface GPU {
    requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
    getPreferredCanvasFormat(): GPUTextureFormat;
  }

  interface GPUAdapter {
    requestDevice(descriptor?: GPUDeviceDescriptor): Promise<GPUDevice>;
  }
}

// 他の型はDOM APIに含まれている
export {};
