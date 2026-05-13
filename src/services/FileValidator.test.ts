/**
 * Tests for FileValidator service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { FileValidator } from './FileValidator';

// Store the real document.createElement to avoid nested mocking
const realCreateElement = document.createElement.bind(document);

describe('FileValidator', () => {
  let validator: FileValidator;

  beforeEach(() => {
    validator = new FileValidator();
  });

  describe('getSupportedFormats', () => {
    it('should return array of supported formats', () => {
      const formats = validator.getSupportedFormats();
      expect(formats).toEqual(['mp4', 'mov', 'webm']);
    });

    it('should return a new array instance', () => {
      const formats1 = validator.getSupportedFormats();
      const formats2 = validator.getSupportedFormats();
      expect(formats1).not.toBe(formats2);
    });
  });

  describe('validateFormat', () => {
    it('should accept MP4 format', () => {
      const file = new File([], 'video.mp4', { type: 'video/mp4' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(true);
      expect(result.details?.format).toBe('mp4');
    });

    it('should accept MOV format', () => {
      const file = new File([], 'video.mov', { type: 'video/quicktime' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(true);
      expect(result.details?.format).toBe('mov');
    });

    it('should accept WebM format', () => {
      const file = new File([], 'video.webm', { type: 'video/webm' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(true);
      expect(result.details?.format).toBe('webm');
    });

    it('should accept uppercase extensions', () => {
      const file = new File([], 'video.MP4', { type: 'video/mp4' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(true);
      expect(result.details?.format).toBe('mp4');
    });

    it('should reject unsupported format', () => {
      const file = new File([], 'video.avi', { type: 'video/avi' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unsupported format');
      expect(result.error).toContain('AVI');
      expect(result.error).toContain('MP4, MOV, WebM');
    });

    it('should reject file without extension', () => {
      const file = new File([], 'video', { type: 'video/mp4' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('No file extension found');
      expect(result.error).toContain('MP4, MOV, WebM');
    });

    it('should reject file with only dot', () => {
      const file = new File([], 'video.', { type: 'video/mp4' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('No file extension found');
    });

    it('should handle multiple dots in filename', () => {
      const file = new File([], 'my.video.file.mp4', { type: 'video/mp4' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(true);
      expect(result.details?.format).toBe('mp4');
    });
  });

  describe('validateResolution', () => {
    it('should accept 720p video', async () => {
      const file = createMockVideoFile(1280, 720);
      const result = await validator.validateResolution(file);
      expect(result.valid).toBe(true);
      expect(result.details?.resolution).toEqual({ width: 1280, height: 720 });
    });

    it('should accept 1080p video', async () => {
      const file = createMockVideoFile(1920, 1080);
      const result = await validator.validateResolution(file);
      expect(result.valid).toBe(true);
      expect(result.details?.resolution).toEqual({ width: 1920, height: 1080 });
    });

    it('should accept 4K video', async () => {
      const file = createMockVideoFile(3840, 2160);
      const result = await validator.validateResolution(file);
      expect(result.valid).toBe(true);
      expect(result.details?.resolution).toEqual({ width: 3840, height: 2160 });
    });

    it('should accept 480p video', async () => {
      const file = createMockVideoFile(854, 480);
      const result = await validator.validateResolution(file);
      expect(result.valid).toBe(true);
      expect(result.details?.resolution).toEqual({ width: 854, height: 480 });
    });

    it('should accept video below 720p', async () => {
      const file = createMockVideoFile(1024, 576);
      const result = await validator.validateResolution(file);
      expect(result.valid).toBe(true);
    });
  });

  describe('Edge Cases - Resolution Boundaries', () => {
    it('should accept exactly 720p resolution (boundary case)', async () => {
      const file = createMockVideoFile(1280, 720);
      const result = await validator.validateResolution(file);
      expect(result.valid).toBe(true);
      expect(result.details?.resolution).toEqual({ width: 1280, height: 720 });
    });

    it('should accept 721p resolution (just above boundary)', async () => {
      const file = createMockVideoFile(1282, 721);
      const result = await validator.validateResolution(file);
      expect(result.valid).toBe(true);
      expect(result.details?.resolution).toEqual({ width: 1282, height: 721 });
    });

    it('should accept 719p resolution (just below boundary)', async () => {
      const file = createMockVideoFile(1278, 719);
      const result = await validator.validateResolution(file);
      expect(result.valid).toBe(true);
      expect(result.details?.resolution).toEqual({ width: 1278, height: 719 });
    });

    it('should accept very low resolution (144p)', async () => {
      const file = createMockVideoFile(256, 144);
      const result = await validator.validateResolution(file);
      expect(result.valid).toBe(true);
    });

    it('should accept non-standard resolution above 720p', async () => {
      const file = createMockVideoFile(1500, 800);
      const result = await validator.validateResolution(file);
      expect(result.valid).toBe(true);
      expect(result.details?.resolution).toEqual({ width: 1500, height: 800 });
    });

    it('should handle invalid video file gracefully', async () => {
      const file = new File(['invalid content'], 'video.mp4', { type: 'video/mp4' });
      
      // Mock createElement to simulate video loading error
      const originalCreateElement = document.createElement.bind(document);
      document.createElement = ((tagName: string) => {
        if (tagName === 'video') {
          const video = originalCreateElement('video') as HTMLVideoElement;
          Object.defineProperty(video, 'src', {
            set: function () {
              setTimeout(() => {
                if (video.onerror) {
                  video.onerror(new Event('error'));
                }
              }, 0);
            },
          });
          return video;
        }
        return originalCreateElement(tagName);
      }) as typeof document.createElement;

      const result = await validator.validateResolution(file);
      
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Unable to read video resolution. Please ensure the file is a valid video.');
      
      // Restore
      document.createElement = originalCreateElement;
    });
  });

  describe('Edge Cases - Format Validation Error Messages', () => {
    it('should include all supported formats in error message for unsupported format', () => {
      const file = new File([], 'video.avi', { type: 'video/avi' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unsupported format: AVI');
      expect(result.error).toContain('MP4');
      expect(result.error).toContain('MOV');
      expect(result.error).toContain('WebM');
    });

    it('should format error message correctly for missing extension', () => {
      const file = new File([], 'videofile', { type: 'video/mp4' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('No file extension found. Supported formats: MP4, MOV, WebM');
    });

    it('should show uppercase format in error message', () => {
      const file = new File([], 'video.mkv', { type: 'video/mkv' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unsupported format: MKV');
    });

    it('should handle empty filename gracefully', () => {
      const file = new File([], '', { type: 'video/mp4' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('No file extension found');
    });

    it('should handle filename with only extension', () => {
      const file = new File([], '.mp4', { type: 'video/mp4' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(true);
      expect(result.details?.format).toBe('mp4');
    });

    it('should handle filename with spaces', () => {
      const file = new File([], 'my video file.mp4', { type: 'video/mp4' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(true);
      expect(result.details?.format).toBe('mp4');
    });

    it('should handle filename with special characters', () => {
      const file = new File([], 'video_2024-01-01_final(1).mov', { type: 'video/quicktime' });
      const result = validator.validateFormat(file);
      expect(result.valid).toBe(true);
      expect(result.details?.format).toBe('mov');
    });
  });

  describe('Property-Based Tests', () => {
    /**
     * **Validates: Requirements 2.4**
     * 
     * Property 1: Invalid file format rejection
     * For any file with an extension not in the set {mp4, mov, webm},
     * the File_Validator SHALL reject the file and return an error message
     * listing the supported formats.
     */
    it('Property 1: should reject any unsupported file format', () => {
      fc.assert(
        fc.property(
          fc
            .string({ minLength: 1, maxLength: 10 })
            .filter((ext) => !['mp4', 'mov', 'webm'].includes(ext.toLowerCase())),
          (invalidExt) => {
            const file = new File([], `video.${invalidExt}`, { type: 'video/mp4' });
            const result = validator.validateFormat(file);
            
            expect(result.valid).toBe(false);
            expect(result.error).toBeDefined();
            expect(result.error).toContain('MP4');
            expect(result.error).toContain('MOV');
            expect(result.error).toContain('WebM');
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property 2: Supported formats always accepted
     * For any file with extension in {mp4, mov, webm},
     * the File_Validator SHALL accept the file.
     */
    it('Property 2: should accept all supported formats', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('mp4', 'mov', 'webm'),
          fc.constantFrom('lower', 'upper', 'mixed'),
          (format, casing) => {
            let filename: string;
            if (casing === 'lower') {
              filename = `video.${format}`;
            } else if (casing === 'upper') {
              filename = `video.${format.toUpperCase()}`;
            } else {
              filename = `video.${format.charAt(0).toUpperCase()}${format.slice(1)}`;
            }
            
            const file = new File([], filename, { type: 'video/mp4' });
            const result = validator.validateFormat(file);
            
            expect(result.valid).toBe(true);
            expect(result.details?.format).toBe(format.toLowerCase());
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property 3: Resolution validation threshold
     * Any video resolution is allowed (e.g. 144p and up), validation SHALL pass.
     */
    it('Property 3: should validate resolution threshold correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 144, max: 3840 }),
          fc.integer({ min: 144, max: 2160 }),
          async (width, height) => {
            const file = createMockVideoFile(width, height);
            const result = await validator.validateResolution(file);
            
            expect(result.valid).toBe(true);
            expect(result.details?.resolution).toEqual({ width, height });
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

/**
 * Helper function to create a mock video file with specific resolution
 * This mocks the video element's metadata loading behavior
 */
function createMockVideoFile(width: number, height: number): File {
  const file = new File([], 'video.mp4', { type: 'video/mp4' });
  
  // Mock URL.createObjectURL to return a predictable URL
  URL.createObjectURL = () => `blob:mock-${width}x${height}`;
  URL.revokeObjectURL = () => {};
  
  // Mock document.createElement for video elements
  const originalCreateElement = document.createElement.bind(document);
  document.createElement = ((tagName: string) => {
    if (tagName === 'video') {
      const video = realCreateElement('video') as HTMLVideoElement;
      
      // Override the src setter to trigger metadata loading
      Object.defineProperty(video, 'src', {
        set: function (_value: string) {
          // Simulate synchronous metadata loading
          Object.defineProperty(video, 'videoWidth', { value: width, writable: true, configurable: true });
          Object.defineProperty(video, 'videoHeight', { value: height, writable: true, configurable: true });
          
          if (video.onloadedmetadata) {
            video.onloadedmetadata(new Event('loadedmetadata'));
          }
        },
        get: function () {
          return `blob:mock-${width}x${height}`;
        },
      });
      
      return video;
    }
    return originalCreateElement(tagName);
  }) as typeof document.createElement;
  
  // Restore original functions after test
  // Removed setTimeout restoration to keep mock active for all tests
  
  return file;
}
