"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { Button } from "@/components/ui/button";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Link as LinkIcon,
  Heading2,
  Quote,
  Undo,
  Redo,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useCallback } from "react";

type SectionTiptapEditorProps = {
  content: string; // Tiptap JSON string, HTML, or markdown
  onChange: (content: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  /** When true, emits markdown instead of HTML */
  markdownMode?: boolean;
};

export function SectionTiptapEditor({
  content,
  onChange,
  placeholder = "Start writing...",
  readOnly = false,
  className,
  markdownMode = false,
}: SectionTiptapEditorProps) {
  const extensions = [
    StarterKit.configure({
      heading: { levels: [2, 3] },
    }),
    Link.configure({
      openOnClick: false,
      HTMLAttributes: {
        class: "text-primary underline underline-offset-2",
      },
    }),
    Placeholder.configure({
      placeholder,
    }),
    ...(markdownMode
      ? [Markdown.configure({ html: true, transformPastedText: true })]
      : []),
  ];

  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    content: parseContent(content),
    editable: !readOnly,
    onUpdate: ({ editor }) => {
      if (markdownMode) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const md = (editor.storage as any).markdown as MarkdownStorage;
        onChange(md.getMarkdown());
      } else {
        onChange(editor.getHTML());
      }
    },
    editorProps: {
      attributes: {
        class: cn(
          "prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[100px] px-3 py-2",
          readOnly && "opacity-80"
        ),
      },
    },
  });

  // Update content when prop changes externally
  useEffect(() => {
    if (editor && !editor.isFocused) {
      const parsed = parseContent(content);
      const currentJson = JSON.stringify(editor.getJSON());
      const newJson = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      if (currentJson !== newJson && typeof parsed !== "string") {
        editor.commands.setContent(parsed);
      }
    }
  }, [content, editor]);

  // Update editable state
  useEffect(() => {
    if (editor) {
      editor.setEditable(!readOnly);
    }
  }, [readOnly, editor]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes("link").href;
    const url = window.prompt("URL", previousUrl);

    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }, [editor]);

  if (!editor) return null;

  return (
    <div className={cn("rounded-md border bg-background", className)}>
      {/* Bubble menu — appears on text selection */}
      {!readOnly && (
        <BubbleMenu
          editor={editor}
          className="flex items-center gap-0.5 rounded-lg border bg-background p-1 shadow-md"
        >
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBold().run()}
            active={editor.isActive("bold")}
            title="Bold"
          >
            <Bold className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleItalic().run()}
            active={editor.isActive("italic")}
            title="Italic"
          >
            <Italic className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            onClick={setLink}
            active={editor.isActive("link")}
            title="Link"
          >
            <LinkIcon className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
            active={editor.isActive("heading", { level: 2 })}
            title="Heading"
          >
            <Heading2 className="size-3.5" />
          </ToolbarButton>
        </BubbleMenu>
      )}

      {/* Static toolbar */}
      {!readOnly && (
        <div className="flex items-center gap-0.5 border-b px-2 py-1">
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBold().run()}
            active={editor.isActive("bold")}
            title="Bold"
          >
            <Bold className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleItalic().run()}
            active={editor.isActive("italic")}
            title="Italic"
          >
            <Italic className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
            active={editor.isActive("heading", { level: 2 })}
            title="Heading"
          >
            <Heading2 className="size-3.5" />
          </ToolbarButton>
          <div className="w-px h-4 bg-border mx-1" />
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            active={editor.isActive("bulletList")}
            title="Bullet list"
          >
            <List className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            active={editor.isActive("orderedList")}
            title="Numbered list"
          >
            <ListOrdered className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            active={editor.isActive("blockquote")}
            title="Quote"
          >
            <Quote className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            onClick={setLink}
            active={editor.isActive("link")}
            title="Link"
          >
            <LinkIcon className="size-3.5" />
          </ToolbarButton>
          <div className="flex-1" />
          <ToolbarButton
            onClick={() => editor.chain().focus().undo().run()}
            disabled={!editor.can().undo()}
            title="Undo"
          >
            <Undo className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().redo().run()}
            disabled={!editor.can().redo()}
            title="Redo"
          >
            <Redo className="size-3.5" />
          </ToolbarButton>
        </div>
      )}

      <EditorContent editor={editor} />
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  active,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        "size-7",
        active && "bg-accent text-accent-foreground"
      )}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </Button>
  );
}

/**
 * Parse content string into Tiptap-compatible format.
 * Handles JSON (Tiptap format), HTML, or plain text.
 */
function parseContent(content: string): Record<string, unknown> | string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && parsed.type === "doc") {
      return parsed;
    }
    return content;
  } catch {
    // Not JSON — treat as HTML or plain text
    return content;
  }
}
