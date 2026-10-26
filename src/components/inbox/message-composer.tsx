
"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  KeyboardEvent,
} from "react";
import {
  Send,
  LayoutTemplate,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  Mic,
  Square,
  X,
  Loader2,
  Sparkles,
  Plus,
  MessageSquareDashed,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  uploadAccountMedia,
  deleteAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from "@/lib/storage/upload-media";
import { ReplyQuote } from "./reply-quote";
import { useTranslations } from "next-intl";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import { validateInteractivePayload } from "@/lib/whatsapp/interactive";
import type { InteractiveMessagePayload, QuickReply } from "@/types";
import { QuickReplyPicker } from "./quick-reply-picker";

export type ComposerMediaKind = "image" | "video" | "document" | "audio";

export const CHAT_MEDIA_BUCKET = "chat-media";
export const MEDIA_CAPTION_MAX = 1024;

const MAX_RECORDING_SECONDS = 5 * 60;

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  mediaUrl: string;
  path: string;
  caption?: string;
  filename?: string;
  replyToId?: string;
}

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

const PICKER_ACCEPT: Record<"image" | "video" | "document", string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

interface MediaDraft {
  kind: ComposerMediaKind;
  mediaUrl: string;
  path: string;
  filename: string;
  caption: string;
}

interface MessageComposerProps {
  conversationId: string;
  sessionExpired: boolean;
  onSend: (text: string, replyToId?: string) => void;
  onSendMedia: (payload: SendMediaPayload) => void;
  onSendInteractive: (
    payload: InteractiveMessagePayload,
    replyToId?: string
  ) => void;
  onOpenTemplates: () => void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";

export function MessageComposer({
  conversationId,
  sessionExpired,
  onSend,
  onSendMedia,
  onSendInteractive,
  onOpenTemplates,
  replyTo,
  onClearReply,
}: MessageComposerProps) {
  const t = useTranslations("Inbox.composer");

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [interactiveOpen, setInteractiveOpen] = useState(false);
  const [interactivePayload, setInteractivePayload] =
    useState<InteractiveMessagePayload>(blankButtonsPayload);
  const [savingQuickReply, setSavingQuickReply] = useState(false);

  // Respuestas rápidas.
  const [quickReplyOpen, setQuickReplyOpen] = useState(false);
  const [quickReplyQuery, setQuickReplyQuery] = useState("");

  const [draft, setDraft] = useState<MediaDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<MediaDraft | null>(null);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const removeStaged = useCallback((path: string | undefined) => {
    if (!path) return;
    void deleteAccountMedia(CHAT_MEDIA_BUCKET, path).catch(() => {});
  }, []);

  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<import("opus-recorder").default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const canSend = useCan("send-messages");
  const readOnly = !canSend;
  const inputsDisabled = readOnly || sessionExpired;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearTimer();
      cancelledRef.current = true;
      void recorderRef.current?.stop().catch(() => {});
      removeStaged(draftRef.current?.path);
    };
  }, [clearTimer, removeStaged]);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || sessionExpired) return;

    setSending(true);
    try {
      onSend(trimmed, replyTo?.id);
      setText("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } finally {
      setSending(false);
    }
  }, [text, sending, sessionExpired, onSend, replyTo?.id]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );

  // Detecta / y abre el selector de respuestas rápidas.
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const command = value.match(/^\/([^\s]*)$/);

      if (command && !inputsDisabled) {
        setQuickReplyQuery(command[1]);
        setQuickReplyOpen(true);
        setText("");
        requestAnimationFrame(adjustHeight);
        return;
      }

      setText(value);
      requestAnimationFrame(adjustHeight);
    },
    [adjustHeight, inputsDisabled]
  );

  const handleDraft = useCallback(async () => {
    if (drafting) return;
    setDrafting(true);

    try {
      const res = await fetch("/api/ai/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data.code === "ai_not_configured") {
          toast.error(t("aiNotConfigured"));
        } else {
          toast.error(data.error ?? t("draftFailed"));
        }
        return;
      }

      const draftText =
        typeof data.draft === "string" ? data.draft.trim() : "";

      if (!draftText) {
        toast.error(t("draftEmpty"));
        return;
      }

      setText(draftText);

      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } catch {
      toast.error(t("aiUnreachable"));
    } finally {
      setDrafting(false);
    }
  }, [drafting, conversationId, adjustHeight, t]);

  const openInteractiveBuilder = useCallback(
    (seed?: InteractiveMessagePayload) => {
      setInteractivePayload(seed ?? blankButtonsPayload());
      setInteractiveOpen(true);
    },
    []
  );

  const sendInteractive = useCallback(() => {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    onSendInteractive(interactivePayload, replyTo?.id);
    setInteractiveOpen(false);
    onClearReply?.();
  }, [interactivePayload, onSendInteractive, replyTo?.id, onClearReply]);

  const saveAsQuickReply = useCallback(async () => {
    const result = validateInteractivePayload(interactivePayload);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    const title = window.prompt(t("quickReplyNamePrompt"))?.trim();
    if (!title) return;

    setSavingQuickReply(true);

    try {
      const res = await fetch("/api/quick-replies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          kind: "interactive",
          interactive_payload: interactivePayload,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        toast.error(data.error ?? t("quickReplySaveError"));
        return;
      }

      toast.success(t("quickReplySaved"));
    } catch {
      toast.error(t("quickReplySaveError"));
    } finally {
      setSavingQuickReply(false);
    }
  }, [interactivePayload, t]);

  const handlePickQuickReply = useCallback(
    (qr: QuickReply) => {
      setQuickReplyOpen(false);
      setQuickReplyQuery("");

      if (qr.kind === "interactive" && qr.interactive_payload) {
        openInteractiveBuilder(qr.interactive_payload);
        return;
      }

      const body = qr.content_text ?? "";

      setText((prev) =>
        prev && !/\s$/.test(prev)
          ? `${prev}\n${body}`
          : `${prev}${body}`
      );

      requestAnimationFrame(() => {
        adjustHeight();
        const el = textareaRef.current;

        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    },
    [openInteractiveBuilder, adjustHeight]
  );

  const stageUpload = useCallback(
    async (kind: ComposerMediaKind, file: File) => {
      const max = MEDIA_MAX_BYTES_BY_KIND[kind];

      if (file.size > max) {
        toast.error(
          `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — ${kind} limit is ${Math.round(
            max / 1024 / 1024
          )} MB.`
        );
        return;
      }

      setBusy(true);

      try {
        const { publicUrl, path } = await uploadAccountMedia(
          CHAT_MEDIA_BUCKET,
          file
        );

        removeStaged(draftRef.current?.path);

        setDraft({
          kind,
          mediaUrl: publicUrl,
          path,
          filename: file.name,
          caption: "",
        });
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Upload failed."
        );
      } finally {
        setBusy(false);
      }
    },
    [removeStaged]
  );

  const handlePicked = useCallback(
    (
      kind: "image" | "video" | "document",
      file: File | undefined
    ) => {
      if (file) void stageUpload(kind, file);
    },
    [stageUpload]
  );

  const finalizeRecording = useCallback(
    async (bytes: Uint8Array) => {
      const file = new File(
        [bytes as unknown as BlobPart],
        `voice-${Date.now()}.ogg`,
        { type: "audio/ogg" }
      );

      if (file.size === 0) return;

      if (file.size > MEDIA_MAX_BYTES_BY_KIND.audio) {
        toast.error(t("recordingTooLong"));
        return;
      }

      setBusy(true);

      try {
        const { publicUrl, path } = await uploadAccountMedia(
          CHAT_MEDIA_BUCKET,
          file
        );

        removeStaged(draftRef.current?.path);

        setDraft({
          kind: "audio",
          mediaUrl: publicUrl,
          path,
          filename: file.name,
          caption: "",
        });
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Upload failed."
        );
      } finally {
        setBusy(false);
      }
    },
    [removeStaged, t]
  );

  const startRecording = useCallback(async () => {
    if (inputsDisabled || busy || recording) return;

    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioContext === "undefined"
    ) {
      toast.error(t("recordingUnsupported"));
      return;
    }

    try {
      const { default: Recorder } = await import("opus-recorder");

      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048,
        encoderSampleRate: 48000,
        streamPages: false,
      });

      cancelledRef.current = false;

      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return;
        void finalizeRecording(bytes);
      };

      recorderRef.current = recorder;
      await recorder.start();

      setRecording(true);
      setRecordSeconds(0);

      timerRef.current = setInterval(
        () => setRecordSeconds((s) => s + 1),
        1000
      );
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      toast.error(t("microphoneDenied"));
    }
  }, [inputsDisabled, busy, recording, finalizeRecording, t]);

  const stopRecording = useCallback(() => {
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) {
      stopRecording();
    }
  }, [recording, recordSeconds, stopRecording]);

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;

    onSendMedia({
      kind: draft.kind,
      mediaUrl: draft.mediaUrl,
      path: draft.path,
      caption:
        draft.kind === "audio"
          ? undefined
          : draft.caption.trim() || undefined,
      filename:
        draft.kind === "document" ? draft.filename : undefined,
      replyToId: replyTo?.id,
    });

    setDraft(null);
    onClearReply?.();
  }, [draft, busy, onSendMedia, replyTo?.id, onClearReply]);

  const discardDraft = useCallback(() => {
    removeStaged(draft?.path);
    setDraft(null);
  }, [draft?.path, removeStaged]);

  const setCaption = useCallback((caption: string) => {
    setDraft((d) => (d ? { ...d, caption } : d));
  }, []);

  return (
    <div className="border-t border-border bg-card p-3">
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}

      {sessionExpired && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-400">
            {t("sessionExpiredHint")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-400 hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="mr-1 h-3 w-3" />
            {t("templates")}
          </Button>
        </div>
      )}

      <input
        ref={imageInputRef}
        type="file"
        accept={PICKER_ACCEPT.image}
        className="hidden"
        onChange={(e) => {
          handlePicked("image", e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <input
        ref={videoInputRef}
        type="file"
        accept={PICKER_ACCEPT.video}
        className="hidden"
        onChange={(e) => {
          handlePicked("video", e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <input
        ref={documentInputRef}
        type="file"
        accept={PICKER_ACCEPT.document}
        className="hidden"
        onChange={(e) => {
          handlePicked("document", e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {draft ? (
        <MediaDraftPreview
          draft={draft}
          busy={busy}
          readOnly={readOnly}
          onCaptionChange={setCaption}
          onDiscard={discardDraft}
          onSend={sendDraft}
          t={t}
        />
      ) : recording ? (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-muted px-4 py-2.5">
          <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />

          <span className="flex-1 text-sm text-foreground">
            {t("recording", {
              current: formatDuration(recordSeconds),
              max: formatDuration(MAX_RECORDING_SECONDS),
            })}
          </span>

          <button
            type="button"
            onClick={cancelRecording}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-card hover:text-foreground"
          >
            {t("cancel")}
          </button>

          <Button
            size="sm"
            onClick={stopRecording}
            className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90"
            title={t("stopAndAttach")}
          >
            <Square className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled || busy}
              title={
                readOnly
                  ? t("readOnlyTitle")
                  : inputsDisabled
                    ? undefined
                    : t("attachMedia")
              }
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="h-4 w-4" />
              )}
            </DropdownMenuTrigger>

            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              <DropdownMenuItem
                onClick={() => imageInputRef.current?.click()}
              >
                <ImageIcon className="mr-2 h-4 w-4" />
                {t("photo")}
              </DropdownMenuItem>

              <DropdownMenuItem
                onClick={() => videoInputRef.current?.click()}
              >
                <Video className="mr-2 h-4 w-4" />
                {t("video")}
              </DropdownMenuItem>

              <DropdownMenuItem
                onClick={() => documentInputRef.current?.click()}
              >
                <FileText className="mr-2 h-4 w-4" />
                {t("document")}
              </DropdownMenuItem>

              <DropdownMenuItem
                onClick={() => void startRecording()}
              >
                <Mic className="mr-2 h-4 w-4" />
                {t("voiceNote")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={inputsDisabled}
              title={
                readOnly
                  ? t("readOnlyTitle")
                  : inputsDisabled
                    ? undefined
                    : t("moreActions")
              }
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
            </DropdownMenuTrigger>

            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              <DropdownMenuItem
                onClick={() => openInteractiveBuilder()}
              >
                <MessageSquareDashed className="mr-2 h-4 w-4" />
                {t("interactiveMessage")}
              </DropdownMenuItem>

              <DropdownMenuItem
                onClick={() => {
                  setQuickReplyQuery("");
                  setQuickReplyOpen(true);
                }}
              >
                <Zap className="mr-2 h-4 w-4" />
                {t("quickReplies")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            title={readOnly ? undefined : t("sendTemplate")}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-foreground"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="h-4 w-4" />
          </GatedButton>

          <GatedButton
            variant="ghost"
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            disabled={drafting}
            title={readOnly ? undefined : t("draftWithAI")}
            className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-primary"
            onClick={handleDraft}
          >
            {drafting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
          </GatedButton>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              readOnly
                ? t("readOnlyPlaceholder")
                : sessionExpired
                  ? t("sessionExpiredPlaceholder")
                  : t("typeMessagePlaceholder")
            }
            disabled={sessionExpired || readOnly}
            rows={1}
            title={readOnly ? t("readOnlyTitle") : undefined}
            className={cn(
              "flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50",
              (sessionExpired || readOnly) &&
                "cursor-not-allowed opacity-50"
            )}
          />

          <GatedButton
            size="sm"
            canAct={!readOnly}
            gateReason="send messages"
            disabled={!text.trim() || sessionExpired || sending}
            onClick={handleSend}
            className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </GatedButton>
        </div>
      )}

      {!draft && !recording && (
        <p className="mt-1 pl-[5.5rem] text-[10px] text-muted-foreground">
          {t("draftHint")}
        </p>
      )}

      <Dialog
        open={interactiveOpen}
        onOpenChange={setInteractiveOpen}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t("interactiveMessage")}
            </DialogTitle>
          </DialogHeader>

          <div className="max-h-[70vh] overflow-y-auto">
            <InteractiveBuilder
              value={interactivePayload}
              onChange={setInteractivePayload}
            />
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              disabled={savingQuickReply}
              onClick={saveAsQuickReply}
            >
              {savingQuickReply ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Zap className="mr-1 h-4 w-4" />
              )}
              {t("saveAsQuickReply")}
            </Button>

            <Button onClick={sendInteractive}>
              <Send className="mr-1 h-4 w-4" />
              {t("send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <QuickReplyPicker
        open={quickReplyOpen}
        onOpenChange={setQuickReplyOpen}
        onPick={handlePickQuickReply}
        initialQuery={quickReplyQuery}
      />
    </div>
  );
}

function MediaDraftPreview({
  draft,
  busy,
  readOnly,
  onCaptionChange,
  onDiscard,
  onSend,
  t,
}: {
  draft: MediaDraft;
  busy: boolean;
  readOnly: boolean;
  onCaptionChange: (caption: string) => void;
  onDiscard: () => void;
  onSend: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {draft.kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.mediaUrl}
              alt={draft.filename}
              className="max-h-40 rounded-lg object-cover"
            />
          )}

          {draft.kind === "video" && (
            <video
              src={draft.mediaUrl}
              controls
              className="max-h-40 rounded-lg"
            />
          )}

          {draft.kind === "audio" && (
            <audio
              src={draft.mediaUrl}
              controls
              className="w-full"
            />
          )}

          {draft.kind === "document" && (
            <div className="flex items-center gap-2 text-sm text-foreground">
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {draft.filename}
              </span>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onDiscard}
          aria-label={t("removeAttachment")}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 flex items-end gap-2">
        {draft.kind !== "audio" && (
          <input
            value={draft.caption}
            maxLength={MEDIA_CAPTION_MAX}
            onChange={(e) =>
              onCaptionChange(e.target.value)
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={t("addCaption")}
            className="flex-1 rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50"
          />
        )}

        <GatedButton
          size="sm"
          canAct={!readOnly}
          gateReason="send messages"
          disabled={busy}
          onClick={onSend}
          className={cn(
            "h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40",
            draft.kind === "audio" && "ml-auto"
          )}
        >
          <Send className="h-4 w-4" />
        </GatedButton>
      </div>
    </div>
  );
}
