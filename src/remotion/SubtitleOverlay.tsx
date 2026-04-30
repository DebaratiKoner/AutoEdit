/**
 * SubtitleOverlay Component
 * Renders synchronized subtitles over video content
 */

import { AbsoluteFill } from 'remotion';
import type { SubtitleDefinition, SubtitleStyle } from '../types';

interface SubtitleOverlayProps {
  subtitles: SubtitleDefinition[];
  currentFrame: number;
}

const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontSize: 32,
  fontFamily: 'Arial, sans-serif',
  color: '#FFFFFF',
  backgroundColor: 'rgba(0, 0, 0, 0.75)',
  position: 'bottom',
  padding: 40,
};

export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({ subtitles, currentFrame }) => {
  // Find subtitle for current frame
  const currentSubtitle = subtitles.find(
    (sub) => currentFrame >= sub.startFrame && currentFrame < sub.endFrame
  );

  if (!currentSubtitle) return null;

  const style = currentSubtitle.style || DEFAULT_SUBTITLE_STYLE;

  return (
    <AbsoluteFill
      style={{
        justifyContent:
          style.position === 'top' ? 'flex-start' : style.position === 'center' ? 'center' : 'flex-end',
        alignItems: 'center',
        padding: style.padding,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          backgroundColor: style.backgroundColor,
          color: style.color,
          fontSize: style.fontSize,
          fontFamily: style.fontFamily,
          padding: '8px 16px',
          borderRadius: '4px',
          maxWidth: '80%',
          textAlign: 'center',
          lineHeight: 1.4,
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        }}
      >
        {currentSubtitle.text}
      </div>
    </AbsoluteFill>
  );
};
