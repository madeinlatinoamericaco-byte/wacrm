
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, MessageSquare, Zap } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { QuickReply } from "@/types";
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive";

interface QuickReplyPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (qr: QuickReply) => void;
  initialQuery?: string;
  onQueryChange?: (query: string) => void;
}

export function QuickReplyPicker({
  open,
  onOpenChange,
  onPick,
  initialQuery = "",
  onQueryChange,
}: QuickReplyPickerProps) {
  const t = useTranslations("Inbox.composer");

  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState(initialQuery);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;

    setQuery(initialQuery);

    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const res = await fetch("/api/quick-replies", {
          cache: "no-store",
        });

        if (!res.ok) {
          throw new Error("No se pudieron cargar las respuestas rápidas");
        }

        const data = await res.json();

        if (!cancelled) {
          setItems(
            Array.isArray(data.quick_replies)
              ? (data.quick_replies as QuickReply[])
              : [],
          );
        }
      } catch (error) {
        console.error(
          "[WACRM] Error cargando respuestas rápidas:",
          error,
        );

        if (!cancelled) {
          setItems([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, initialQuery]);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query
      .trim()
      .replace(/^\/+/, "")
      .toLocaleLowerCase();

    if (!normalizedQuery) {
      return items;
    }

    return items.filter((qr) => {
      const normalizedTitle = qr.title
        .replace(/^\/+/, "")
        .toLocaleLowerCase();

      return normalizedTitle.includes(normalizedQuery);
    });
  }, [items, query]);

  const updateQuery = (value: string) => {
    setQuery(value);
    onQueryChange?.(value);
  };

  const selectReply = (qr: QuickReply) => {
    onPick(qr);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("quickReplies")}</DialogTitle>
        </DialogHeader>

        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          placeholder="Buscar respuesta rápida..."
          aria-label="Buscar respuesta rápida"
          autoComplete="off"
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
        />

        <div className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filteredItems.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {items.length === 0
                ? t("quickRepliesEmpty")
                : "No se encontraron respuestas rápidas."}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {filteredItems.map((qr) => (
                <li key={qr.id}>
                  <button
                    type="button"
                    onClick={() => selectReply(qr)}
                    className="flex w-full items-start gap-2 rounded-md border border-border bg-muted/40 p-2.5 text-left hover:border-primary/50 hover:bg-muted"
                  >
                    {qr.kind === "interactive" ? (
                      <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    )}

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {qr.title}
                      </span>

                      <span className="block truncate text-xs text-muted-foreground">
                        {qr.kind === "interactive" &&
                        qr.interactive_payload
                          ? interactivePayloadPreviewText(
                              qr.interactive_payload,
                            )
                          : qr.content_text}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
