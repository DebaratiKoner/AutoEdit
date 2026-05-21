from pathlib import Path
text = Path('src/components/EditorPage.tsx').read_text(encoding='utf-8')
chunk = '\n'.join(text.splitlines()[2477-1:3598])
print('opening fragments', chunk.count('<>'))
print('closing fragments', chunk.count('</>'))
