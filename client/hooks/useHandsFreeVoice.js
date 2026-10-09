"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createHandsFreeVoice } from "../lib/handsFreeVoice.mjs";

const initialState = { supported: null, active: false, status: "idle", transcript: "", error: "", paused: false };

export default function useHandsFreeVoice({ botId, onSubmit, busy, approvalPending, completedTurn, streamError, onActivityChange }) {
  const [state, setState] = useState(initialState);
  const controllerRef = useRef(null);
  const callbacksRef = useRef({ onSubmit, onActivityChange });
  callbacksRef.current = { onSubmit, onActivityChange };

  useEffect(() => {
    const controller = createHandsFreeVoice({
      browser: window,
      onSubmit: (text) => callbacksRef.current.onSubmit(text),
      onState: (next) => {
        setState(next);
        callbacksRef.current.onActivityChange?.({ state: next.status, active: next.active });
      },
    });
    controllerRef.current = controller;
    setState(controller.getState());
    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
  }, [botId]);

  useEffect(() => {
    controllerRef.current?.update({ busy, approvalPending, completedTurn, streamError });
  }, [busy, approvalPending, completedTurn, streamError, botId]);

  const start = useCallback(() => controllerRef.current?.start(), []);
  const stop = useCallback(() => controllerRef.current?.stop(), []);
  const resume = useCallback(() => controllerRef.current?.resume(), []);
  const interrupt = useCallback(() => controllerRef.current?.interrupt(), []);
  const sendNow = useCallback(() => controllerRef.current?.sendNow(), []);
  return { ...state, start, stop, resume, interrupt, sendNow };
}
