import { toast as sonnerToast, type ExternalToast } from "sonner";

/** Toast adapter over sonner's `toast`, with the same API. */

type ToastMessage = string | React.ReactNode;

function success(message: ToastMessage, data?: ExternalToast) {
  return sonnerToast.success(message, data);
}

function error(message: ToastMessage, data?: ExternalToast) {
  return sonnerToast.error(message, data);
}

function info(message: ToastMessage, data?: ExternalToast) {
  return sonnerToast.info(message, data);
}

function warning(message: ToastMessage, data?: ExternalToast) {
  return sonnerToast.warning(message, data);
}

function loading(message: ToastMessage, data?: ExternalToast) {
  return sonnerToast.loading(message, data);
}

function message(msg: ToastMessage, data?: ExternalToast) {
  return sonnerToast.message(msg, data);
}

function promise<T>(
  promise: Promise<T> | (() => Promise<T>),
  data: Parameters<typeof sonnerToast.promise<T>>[1],
) {
  return sonnerToast.promise(promise, data);
}

function dismiss(id?: string | number) {
  return sonnerToast.dismiss(id);
}

function custom(
  jsx: Parameters<typeof sonnerToast.custom>[0],
  data?: ExternalToast,
) {
  return sonnerToast.custom(jsx, data);
}

export const toast = {
  success,
  error,
  info,
  warning,
  loading,
  message,
  promise,
  dismiss,
  custom,
} as const;
