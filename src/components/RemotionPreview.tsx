/**
 * RemotionPreview Component
 * Embeds Remotion Player in EditorPage for real-time preview
 */

import { useEffect, useState } from 'react';
import { Player } from '@remotion/player';
import { VideoComposition } from '../remotion/VideoComposition';
import { logger } from '../utils';
import type { CompositionSchema } from '../types';

interface RemotionPreviewProps {
  composition: CompositionSchema;
  currentTime: number;
  onTimeUpdate: (time: number) => void;
  onError: (error: Error) => void;
}

export function RemotionPreview({
  composition,
  currentTime,
  onTimeUpdate,
  onError,
}: RemotionPreviewProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  // Convert current time (seconds) to frame
  const currentFrame = Math.floor(currentTime * composition.fps);

  useEffect(() => {
    setIsLoading(false);
  }, [composition]);

  const handleError = (error: Error) => {
    logger.error('Remotion preview error:', error);
    setHasError(true);
    onError(error);
  };

  if (hasError) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#1a1a2e',
          color: '#e53e3e',
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <div>
          <h3>Preview Error</h3>
          <p>Failed to render Remotion preview. Falling back to native player.</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#1a1a2e',
          color: '#fff',
        }}
      >
        <div>Loading preview...</div>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', backgroundColor: '#000' }}>
      <Player
        component={VideoComposition}
        durationInFrames={composition.durationInFrames}
        compositionWidth={composition.width}
        compositionHeight={composition.height}
        fps={composition.fps}
        inputProps={{
          clips: composition.clips,
          subtitles: composition.subtitles,
          transitions: composition.transitions,
        }}
        style={{
          width: '100%',
          height: '100%',
        }}
        controls
        loop
        initialFrame={currentFrame}
        onError={handleError}
      />
    </div>
  );
}
