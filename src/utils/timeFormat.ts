/**
 * Time formatting utilities
 */

/**
 * Format time in seconds to MM:SS format
 * @param seconds - Time in seconds
 * @returns Formatted time string (MM:SS)
 */
export function formatTime(seconds: number): string {
  const totalSeconds = Math.floor(Math.abs(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  
  const mm = String(minutes).padStart(2, '0');
  const ss = String(remainingSeconds).padStart(2, '0');
  
  return `${mm}:${ss}`;
}
