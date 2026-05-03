/**
 * File Validator Service
 * Validates video files before upload
 */

import type { ValidationResult } from '../types';

export class FileValidator {
  private static readonly SUPPORTED_FORMATS = ['mp4', 'mov', 'webm'];
  private static readonly MIN_HEIGHT = 360;

  /**
   * Get list of supported video formats
   * @returns Array of supported file extensions
   */
  getSupportedFormats(): string[] {
    return [...FileValidator.SUPPORTED_FORMATS];
  }

  /**
   * Validate file format by checking extension
   * @param file - File to validate
   * @returns ValidationResult indicating if format is supported
   */
  validateFormat(file: File): ValidationResult {
    const extension = this.getFileExtension(file.name);
    
    if (!extension) {
      return {
        valid: false,
        error: `No file extension found. Supported formats: ${this.formatSupportedFormats()}`,
      };
    }

    const isSupported = FileValidator.SUPPORTED_FORMATS.includes(extension);
    
    if (!isSupported) {
      return {
        valid: false,
        error: `Unsupported format: ${extension.toUpperCase()}. Supported formats: ${this.formatSupportedFormats()}`,
      };
    }

    return {
      valid: true,
      details: {
        format: extension,
      },
    };
  }

  /**
   * Validate video resolution meets minimum requirements
   * @param file - Video file to validate
   * @returns Promise<ValidationResult> indicating if resolution meets requirements
   */
  async validateResolution(file: File): Promise<ValidationResult> {
    try {
      const resolution = await this.getVideoResolution(file);
      
      if (resolution.height < FileValidator.MIN_HEIGHT) {
        return {
          valid: false,
          error: `Resolution too low: ${resolution.height}p. Minimum ${FileValidator.MIN_HEIGHT}p required.`,
          details: {
            resolution,
          },
        };
      }

      return {
        valid: true,
        details: {
          resolution,
        },
      };
    } catch (error) {
      return {
        valid: false,
        error: 'Unable to read video resolution. Please ensure the file is a valid video.',
      };
    }
  }

  /**
   * Extract file extension from filename
   * @param filename - Name of the file
   * @returns Lowercase file extension without dot, or empty string if none
   */
  private getFileExtension(filename: string): string {
    const lastDotIndex = filename.lastIndexOf('.');
    if (lastDotIndex === -1 || lastDotIndex === filename.length - 1) {
      return '';
    }
    return filename.slice(lastDotIndex + 1).toLowerCase();
  }

  /**
   * Format supported formats as a comma-separated string
   * @returns Formatted string of supported formats
   */
  private formatSupportedFormats(): string {
    return FileValidator.SUPPORTED_FORMATS
      .map(format => format.toUpperCase())
      .join(', ');
  }

  /**
   * Get video resolution by loading it in a video element
   * @param file - Video file to analyze
   * @returns Promise resolving to video resolution
   */
  private getVideoResolution(file: File): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(file);

      video.preload = 'metadata';
      
      video.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve({
          width: video.videoWidth,
          height: video.videoHeight,
        });
      };

      video.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load video metadata'));
      };

      video.src = url;
    });
  }
}
