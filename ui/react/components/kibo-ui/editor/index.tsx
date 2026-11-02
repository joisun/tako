// Selective adaptation of Kibo UI EditorProvider (MIT).
// Source: https://www.kibo-ui.com/r/editor.json. See LICENSE in this directory.
import { EditorProvider as TiptapEditorProvider, useCurrentEditor, type EditorProviderProps as TiptapEditorProviderProps } from '@tiptap/react'
import { useEffect } from 'react'
import StarterKit from '@tiptap/starter-kit'
import { CharacterCount, Placeholder } from '@tiptap/extensions'
import { cn } from '@/lib/cn'

export type EditorProviderProps = TiptapEditorProviderProps & { className?: string; limit?: number; placeholder?: string }

// Messages need paragraphs, undo and line breaks, without document toolbars.
function EditorEditable({ editable }: { editable: boolean }) {
  const { editor } = useCurrentEditor()
  useEffect(() => { editor?.setEditable(editable,false) },[editor,editable])
  return null
}

export function EditorProvider({ className, extensions = [], limit, placeholder, children, editable = true, ...props }: EditorProviderProps) {
  return <div className={cn('kibo-editor', className)}>
    <TiptapEditorProvider immediatelyRender={false} extensions={[
      StarterKit.configure({ bold:false, italic:false, strike:false, underline:false, code:false, codeBlock:false, heading:false, blockquote:false, bulletList:false, orderedList:false, listItem:false, listKeymap:false, horizontalRule:false, link:false, trailingNode:false }),
      Placeholder.configure({ placeholder }), CharacterCount.configure({ limit }), ...extensions,
    ]} editable={editable} {...props}><EditorEditable editable={editable}/>{children}</TiptapEditorProvider>
  </div>
}
