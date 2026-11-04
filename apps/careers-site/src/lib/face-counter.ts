/**
 * Counts the faces in the candidate's camera picture, ON THEIR DEVICE (MediaPipe face detector, short-range model).
 * Only the number is used: no frame is stored or sent, nobody is identified, no expression or gaze is read.
 * The runtime (public/mediapipe/wasm, copied before dev / build) and the model (public/models) come from this site,
 * and are only downloaded once the interview starts with face checking switched on.
 */
export interface FaceCounter {
  /** Faces in the current frame, or null when the frame cannot be read (camera warming up, detector error). */
  count(video: HTMLVideoElement): number | null;
  close(): void;
}

export async function loadFaceCounter(): Promise<FaceCounter> {
  const { FilesetResolver, FaceDetector } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(new URL('/mediapipe/wasm', window.location.origin).href);
  const detector = await FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: new URL('/models/blaze_face_short_range.tflite', window.location.origin).href, delegate: 'CPU' },
    runningMode: 'VIDEO',
    // a confident face only: posters / shadows at low confidence are not counted
    minDetectionConfidence: 0.6,
  });
  let last = 0;
  return {
    count(video) {
      if (video.readyState < 2 || !video.videoWidth) return null;
      // VIDEO mode needs strictly increasing timestamps
      last = Math.max(last + 1, Math.round(performance.now()));
      try {
        return detector.detectForVideo(video, last).detections.length;
      } catch {
        return null;
      }
    },
    close() {
      try {
        detector.close();
      } catch {
        // already closed
      }
    },
  };
}
