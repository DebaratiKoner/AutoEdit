/**
 * VideoClip Component
 * Renders individual video clip with trimming and transitions
 */

import { Sequence, OffthreadVideo, AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Img } from 'remotion';
import type { ClipDefinition, TransitionConfig } from '../types';

interface VideoClipProps {
  clip: ClipDefinition;
  transition?: TransitionConfig;
  isLast: boolean;
}

export const VideoClip: React.FC<VideoClipProps> = ({ clip, transition, isLast }) => {
  const frame = useCurrentFrame();

  // Calculate opacity for transitions.
  // For photos we also need smooth opacity changes so switching video <-> photo <-> video is seamless.
  const opacity = transition?.enabled
    ? calculateOpacity(frame, clip.startFrom, clip.durationInFrames, transition.durationInFrames, isLast)
    : 1;

  const assetKind = clip.assetKind ?? 'video';

  return (
    <Sequence from={clip.startFrom} durationInFrames={clip.durationInFrames}>
      {/*
        Use opacity-only crossfade between adjacent segments.
        Photos are silent because they render as <Img/> only.
      */}
      <AbsoluteFill style={{ opacity }}>
        {assetKind === 'photo' ? (
          // Photos must be silent in the preview. Using <Img/> ensures no audio element is created.
          <Img src={clip.src} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <OffthreadVideo
            src={clip.src}
            startFrom={Math.floor(clip.sourceStart * 30)} // Convert seconds to frames (assuming 30fps source)
            endAt={Math.floor(clip.sourceEnd * 30)}
            // Ensure we do NOT play background audio while previewing the asset section.
            // RemotionPlayer may reuse clips, so keeping preview silent prevents unintended audio.
            muted={true}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        )}
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
