# Backend Setup Script for Windows

Write-Host "Setting up Video Editor Backend..." -ForegroundColor Green

# Check Python installation
Write-Host "`nChecking Python installation..." -ForegroundColor Yellow
try {
    $pythonVersion = python --version 2>&1
    Write-Host "Found: $pythonVersion" -ForegroundColor Green
} catch {
    Write-Host "Python not found! Please install Python 3.8+ from https://www.python.org/downloads/" -ForegroundColor Red
    exit 1
}

# Check FFmpeg installation
Write-Host "`nChecking FFmpeg installation..." -ForegroundColor Yellow
try {
    $ffmpegVersion = ffmpeg -version 2>&1 | Select-Object -First 1
    Write-Host "Found: $ffmpegVersion" -ForegroundColor Green
} catch {
    Write-Host "FFmpeg not found!" -ForegroundColor Red
    Write-Host "Please install FFmpeg:" -ForegroundColor Yellow
    Write-Host "  1. Download from https://ffmpeg.org/download.html" -ForegroundColor Yellow
    Write-Host "  2. Or use Chocolatey: choco install ffmpeg" -ForegroundColor Yellow
    Write-Host "  3. Add to PATH and restart terminal" -ForegroundColor Yellow
    exit 1
}

# Create virtual environment
Write-Host "`nCreating Python virtual environment..." -ForegroundColor Yellow
if (Test-Path "venv") {
    Write-Host "Virtual environment already exists" -ForegroundColor Green
} else {
    python -m venv venv
    Write-Host "Virtual environment created" -ForegroundColor Green
}

# Activate virtual environment
Write-Host "`nActivating virtual environment..." -ForegroundColor Yellow
& .\venv\Scripts\Activate.ps1

# Install dependencies
Write-Host "`nInstalling Python dependencies..." -ForegroundColor Yellow
pip install -r requirements.txt

# Create .env file if it doesn't exist
if (-not (Test-Path ".env")) {
    Write-Host "`nCreating .env file..." -ForegroundColor Yellow
    Copy-Item ".env.example" ".env"
    Write-Host ".env file created" -ForegroundColor Green
    Write-Host "`nIMPORTANT: Please edit .env and add your OpenAI API key!" -ForegroundColor Red
    Write-Host "Get your API key from: https://platform.openai.com/api-keys" -ForegroundColor Yellow
} else {
    Write-Host "`n.env file already exists" -ForegroundColor Green
}

# Create uploads directory
if (-not (Test-Path "uploads")) {
    New-Item -ItemType Directory -Path "uploads" | Out-Null
    Write-Host "`nCreated uploads directory" -ForegroundColor Green
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Backend setup complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "`nNext steps:" -ForegroundColor Yellow
Write-Host "1. Edit backend/.env and add your OPENAI_API_KEY" -ForegroundColor White
Write-Host "2. Run: python main.py" -ForegroundColor White
Write-Host "3. Backend will be available at http://localhost:8000" -ForegroundColor White
Write-Host "`nTo start the server now, run:" -ForegroundColor Yellow
Write-Host "  python main.py" -ForegroundColor Cyan
