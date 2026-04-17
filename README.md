# AutoEdit AI Video Editor

A web-based video editing application that enables users to upload videos, transcribe them using AI, edit content through transcript manipulation, and export the final result.

## Tech Stack

- **Frontend**: React 18+ with TypeScript
- **Build Tool**: Vite
- **Testing**: Vitest, React Testing Library, fast-check (property-based testing)
- **Video Processing**: FFmpeg.wasm (client-side), MoviePy (server-side)
- **Backend**: FastAPI
- **AI Services**: Whisper (transcription), ChatGPT (transcript modification)
- **Rendering**: Remotion
- **Storage**: IndexedDB/localStorage

## Project Structure

```
src/
├── components/       # React UI components
├── services/         # API clients and business logic
├── utils/            # Utility functions (timeline, formatting, etc.)
├── types/            # TypeScript type definitions
└── test/             # Test setup and utilities
```

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

### Testing

```bash
# Run tests once
npm test

# Run tests in watch mode
npm run test:watch
```

### Build

```bash
npm run build
```

## Features

- **Video Upload**: Drag-and-drop interface with format validation (MP4, MOV, WebM)
- **Video Editor**: Timeline-based editing with playback controls
- **AI Transcription**: Automatic speech-to-text using Whisper
- **Editing Tools**: Cut, delete, undo/redo operations
- **Session Persistence**: Auto-save editing sessions to browser storage
- **Video Export**: Render and download edited videos

## Browser Support

- Chrome 90+
- Edge 90+
- Firefox 88+ (best effort)
- Safari 14+ (best effort)

## License

MIT
