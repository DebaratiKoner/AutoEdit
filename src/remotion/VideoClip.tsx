/**
 * VideoClip Component
 * Renders individual video clip with trimming and transitions
 */

import { Sequence, OffthreadVideo, AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import type { ClipDefinition, TransitionConfig } from '../types';

interface VideoClipProps {
  clip: ClipDefinition;
  transition?: TransitionConfig;
  isLast: boolean;
}

export const VideoClip: React.FC<VideoClipProps> = ({ clip, transition, isLast }) => {
  const frame = useCurrentFrame();

  // Calculate opacity for fade transitions
  const opacity = transition?.enabled
    ? calculateOpacity(frame, clip.startFrom, clip.durationInFrames, transition.durationInFrames, isLast)
    : 1;

  return (
    <Sequence from={clip.startFrom} durationInFrames={clip.durationInFrames}>
      <AbsoluteFill style={{ opacity }}>
        <OffthreadVideo
          src={clip.src}
          startFrom={Math.floor(clip.sourceStart * 30)} // Convert seconds to frames (assuming 30fps source)
          endAt={Math.floor(clip.sourceEnd * 30)}
          volume={clip.volume}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      </AbsoluteFill>
    </Sequence>
  );
};

/**
 * Calculate opacity for fade transitions at any given frame
 */
function calculateOpacity(
  currentFrame: number,
  clipStart: number,
  clipDuration: number,
  transitionDuration: number,
  isLast: boolean
): number {
  const relativeFrame = currentFrame - clipStart;

  // Before clip starts: invisible
  if (relativeFrame < 0) return 0;

  // After clip ends: invisible
  if (relativeFrame >= clipDuration) return 0;

  // Fade in at start (first transitionDuration frames)
  if (relativeFrame < transitionDuration) {
    return interpolate(relativeFrame, [0, transitionDuration], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  }

  // Fade out at end (last transitionDuration frames)
  // Skip fade-out for last clip to avoid ending on black
  if (!isLast && relativeFrame > clipDuration - transitionDuration) {
    return interpolate(relativeFrame, [clipDuration - transitionDuration, clipDuration], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  }

  // Fully visible in middle
  return 1;
}
