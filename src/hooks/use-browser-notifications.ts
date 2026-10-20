
"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import type { Message } from "@/types";

import {
  DEFAULT_NOTIFICATION_LABELS,
  buildNotificationContent,
  conversationHref,
  getNotificationPermission,
  pickContactDisplayName,
  readBrowserNotifyPref,
  shouldNotifyForMessage,
  subscribeBrowserNotifyPref,
  viewedConversationFromLocation,
  type NotificationLabels,
} from "@/lib/notifications/browser-notify";

const serverSnapshot = () => false;

const MAX_SEEN_MESSAGES = 500;
const CONTACT_LOOKUP_TIMEOUT_MS = 2500;

/**
 * Contexto de audio compartido por la pestaña.
 * Se desbloquea con la primera interacción del usuario.
 */
let notificationAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;

  try {
    if (!notificationAudioContext ||
        notificationAudioContext.state === "closed") {
      notificationAudioContext = new window.AudioContext();
    }

    return notificationAudioContext;
  } catch (error) {
    console.warn(
      "[WACRM] No se pudo inicializar el audio:",
      error,
    );
    return null;
  }
}

/**
 * Activa el audio después de una interacción del usuario.
 * Chrome puede bloquear audio automático antes de esta acción.
 */
function unlockNotificationAudio(): void {
  const context = getAudioContext();

  if (!context) return;

  if (context.state === "suspended") {
    void context.resume().catch((error) => {
      console.warn(
        "[WACRM] No se pudo activar el audio:",
        error,
      );
    });
  }
}

/**
 * Sonido breve de dos tonos para mensajes nuevos.
 */
function playNotificationSound(): void {
  const context = getAudioContext();

  if (!context) return;

  if (context.state !== "running") {
    console.warn(
      "[WACRM] Audio suspendido. Haz clic en WACRM para activarlo.",
    );
    return;
  }

  try {
    const playTone = (
      frequency: number,
      startTime: number,
      duration: number,
    ) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(
        frequency,
        startTime,
      );

      gain.gain.setValueAtTime(
        0.0001,
        startTime,
      );

      gain.gain.exponentialRampToValueAtTime(
        0.12,
        startTime + 0.015,
      );

      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        startTime + duration,
      );

      oscillator.connect(gain);
      gain.connect(context.destination);

      oscillator.start(startTime);
      oscillator.stop(startTime + duration);

      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    };

    const now = context.currentTime;

    playTone(784, now, 0.12);
    playTone(1046.5, now + 0.14, 0.18);

    console.log(
      "[WACRM] Sonido de notificación reproducido",
    );
  } catch (error) {
    console.warn(
      "[WACRM] Error al reproducir sonido:",
      error,
    );
  }
}

export function useBrowserNotifyPref(): boolean {
  return useSyncExternalStore(
    subscribeBrowserNotifyPref,
    readBrowserNotifyPref,
    serverSnapshot,
  );
}

export function useBrowserNotifications(): void {
  const enabled = useBrowserNotifyPref();
  const router = useRouter();
  const t = useTranslations(
    "Settings.browserNotifications.labels",
  );

  const labelsRef = useRef<NotificationLabels>(
    DEFAULT_NOTIFICATION_LABELS,
  );

  const seenRef = useRef<Map<string, number>>(
    new Map(),
  );

  useEffect(() => {
    labelsRef.current = {
      fallbackTitle: t("fallbackTitle"),
      image: t("image"),
      audio: t("audio"),
      video: t("video"),
      document: t("document"),
      location: t("location"),
      template: t("template"),
    };
  }, [t]);

  /**
   * Prepara el audio después de una interacción.
   */
  useEffect(() => {
    if (!enabled) return;

    const unlock = () => {
      unlockNotificationAudio();
    };

    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);

    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      console.log(
        "[WACRM] Notificaciones desactivadas",
      );
      return;
    }

    if (getNotificationPermission() !== "granted") {
      console.warn(
        "[WACRM] Sin permiso para notificaciones",
      );
      return;
    }

    const supabase = createClient();
    let cancelled = false;

    console.log(
      "[WACRM] Iniciando sistema de notificaciones",
    );

    /**
     * Muestra la notificación y reproduce el sonido.
     */
    const showNotification = (
      msg: Message,
      contactName?: string | null,
    ) => {
      if (cancelled) return;

      if (getNotificationPermission() !== "granted") {
        console.warn(
          "[WACRM] Permiso revocado antes de notificar",
        );
        return;
      }

      const { title, body } = buildNotificationContent(
        msg,
        contactName,
        labelsRef.current,
      );

      try {
        const notification = new Notification(title, {
          body,
          icon: "/icon",
          tag: `wacrm-message-${msg.id}`,
        });

        notification.onclick = () => {
          window.focus();
          router.push(
            conversationHref(msg.conversation_id),
          );
          notification.close();
        };

        // Reproducir sonido al crear la notificación.
        playNotificationSound();

        console.log(
          "[WACRM] Notificación creada:",
          msg.id,
        );
      } catch (error) {
        console.error(
          "[WACRM] Error al crear notificación:",
          error,
        );
      }
    };

    /**
     * Consulta opcional del nombre del contacto.
     */
    const getContactName = async (
      conversationId: string,
    ): Promise<string | null> => {
      try {
        const query = supabase
          .from("conversations")
          .select(
            "contact:contacts(name, wa_username, phone)",
          )
          .eq("id", conversationId)
          .maybeSingle();

        const timeout = new Promise<null>((resolve) => {
          setTimeout(
            () => resolve(null),
            CONTACT_LOOKUP_TIMEOUT_MS,
          );
        });

        const result = await Promise.race([
          query,
          timeout,
        ]);

        if (!result || result.error) {
          return null;
        }

        const contact = (
          result.data as {
            contact?: {
              name?: string | null;
              wa_username?: string | null;
              phone?: string | null;
            } | null;
          } | null
        )?.contact;

        return pickContactDisplayName(contact);
      } catch (error) {
        console.warn(
          "[WACRM] No se pudo consultar el contacto:",
          error,
        );
        return null;
      }
    };

    /**
     * Procesa mensajes entrantes.
     */
    const handleMessage = async (msg: Message) => {
      console.log(
        "[WACRM] Mensaje recibido:",
        msg.id,
        msg.sender_type,
      );

      if (cancelled) return;

      if (getNotificationPermission() !== "granted") {
        return;
      }

      const shouldNotify = shouldNotifyForMessage(
        msg,
        {
          documentVisible:
            document.visibilityState === "visible",
          viewingConversationId:
            viewedConversationFromLocation(
              window.location.pathname,
              window.location.search,
            ),
          seen: seenRef.current,
        },
      );

      if (!shouldNotify) {
        console.log(
          "[WACRM] Mensaje omitido por filtros:",
          msg.id,
        );
        return;
      }

      const contactName = await getContactName(
        msg.conversation_id,
      );

      if (cancelled) return;

      showNotification(msg, contactName);

      /**
       * Evita crecimiento indefinido del mapa.
       */
      if (seenRef.current.size > MAX_SEEN_MESSAGES) {
        const entries = Array.from(
          seenRef.current.entries(),
        );

        seenRef.current = new Map(
          entries.slice(-MAX_SEEN_MESSAGES),
        );
      }
    };

    /**
     * Suscripción a nuevos mensajes de Supabase.
     */
    const channel = supabase
      .channel("browser-notifications")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
        },
        (payload) => {
          const msg = payload.new as Message;

          void handleMessage(msg);
        },
      )
      .subscribe((status, error) => {
        console.log(
          "[WACRM] Estado Realtime:",
          status,
        );

        if (error) {
          console.error(
            "[WACRM] Error Realtime:",
            error,
          );
        }
      });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);

      console.log(
        "[WACRM] Suscripción de notificaciones cerrada",
      );
    };
  }, [enabled, router]);
}
