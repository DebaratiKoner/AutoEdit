import '@testing-library/jest-dom';

// Mock browser APIs that may not be available in test environment
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock IndexedDB if needed
if (typeof window !== 'undefined' && !window.indexedDB) {
  // @ts-expect-error - Mock implementation
  window.indexedDB = {
    open: () => ({
      onsuccess: null,
      onerror: null,
    }),
  };
}
