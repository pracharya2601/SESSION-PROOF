/**
 * Vexo design system (U1). Import from "../design" (pages) or "../../design" (components).
 * See ./README.md for usage.
 */
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export { Card, type CardProps } from "./Card";
export { Badge, type BadgeProps, type BadgeTone } from "./Badge";
export { Input, Textarea, Select, type InputProps, type TextareaProps, type SelectProps, type SelectOption } from "./Inputs";
export { Field, type FieldProps } from "./Field";
export { Switch, type SwitchProps } from "./Switch";
export { Tabs, TabPanel, tabId, panelId, type TabsProps, type TabItem } from "./Tabs";
export { Dialog, type DialogProps } from "./Dialog";
export { Skeleton, type SkeletonProps } from "./Skeleton";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { PageHeader, type PageHeaderProps } from "./PageHeader";
export { AnimatedNumber, formatNumber, type AnimatedNumberProps, type NumberFormat } from "./AnimatedNumber";
export {
  StatusPill,
  STATUS_LABELS,
  STATUS_TONES,
  ACTIVE_STATUSES,
  REASON_STATUSES,
  type StatusPillProps,
  type StatusTone,
} from "./StatusPill";
export { ToastProvider, useToast, type ToastApi, type ToastOptions, type ToastTone } from "./Toast";
export { Spinner } from "./Spinner";
export { Celebration, type CelebrationProps } from "./Celebration";
export { ErrorNotice, errorMessage } from "../components/ErrorNotice";
export { fadeUp, stagger, pageTransition, springy, softSpring, fadeOnly, pressable } from "./motion";
export { cx } from "./cx";
export { useReducedMotion } from "framer-motion";
