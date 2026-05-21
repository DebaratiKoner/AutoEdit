from pathlib import Path
text = Path('src/components/EditorPage.tsx').read_text(encoding='utf-8')
clean = []
state = 'normal'
quote = ''
escaped = False
i = 0
while i < len(text):
    ch = text[i]
    if state == 'normal':
        if ch == '/' and i + 1 < len(text) and text[i+1] == '/':
            state = 'line_comment'
            clean.append(' ')
        elif ch == '/' and i + 1 < len(text) and text[i+1] == '*':
            state = 'block_comment'
            clean.append(' ')
        elif ch in ('"', "'", '`'):
            state = 'string'
            quote = ch
            escaped = False
            clean.append(' ')
        else:
            clean.append(ch)
    elif state == 'string':
        if escaped:
            clean.append(' ')
            escaped = False
        elif ch == '\\':
            escaped = True
            clean.append(' ')
        elif ch == quote:
            state = 'normal'
            clean.append(' ')
        else:
            clean.append(' ')
    elif state == 'line_comment':
        clean.append(' ')
        if ch == '\n':
            state = 'normal'
    elif state == 'block_comment':
        clean.append(' ')
        if ch == '*' and i + 1 < len(text) and text[i+1] == '/':
            clean.append(' ')
            i += 1
            state = 'normal'
    i += 1
clean = ''.join(clean)
paren_stack = []
bracket_stack = []
brace_stack = []
for idx, ch in enumerate(clean, 1):
    if ch == '(':
        paren_stack.append(idx)
    elif ch == ')':
        if not paren_stack:
            print('unmatched close paren at', idx)
            break
        paren_stack.pop()
    elif ch == '[':
        bracket_stack.append(idx)
    elif ch == ']':
        if not bracket_stack:
            print('unmatched close bracket at', idx)
            break
        bracket_stack.pop()
    elif ch == '{':
        brace_stack.append(idx)
    elif ch == '}':
        if not brace_stack:
            print('unmatched close brace at', idx)
            break
        brace_stack.pop()
else:
    if paren_stack:
        print('unclosed paren at', paren_stack[-1])
    elif bracket_stack:
        print('unclosed bracket at', bracket_stack[-1])
    elif brace_stack:
        print('unclosed brace at', brace_stack[-1])
    else:
        print('balanced')
