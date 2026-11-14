import type { ReactNode } from "react";
import { Card } from "../../design";
import { rvItem, rvItemReduced, useMotionOK } from "./motion";

/** A review card (design-system Card) that participates in the page's staggered reveal. */
export function Section(props: {
  label: string;
  title?: ReactNode;
  icon?: ReactNode;
  aside?: ReactNode;
  className?: string;
  glow?: boolean;
  children: ReactNode;
  id?: string;
}) {
  const ok = useMotionOK();
  return (
    <Card
      as="section"
      id={props.id}
      glow={props.glow}
      className={`rv-card ${props.className ?? ""}`}
      aria-label={props.label}
      motionProps={{ variants: ok ? rvItem : rvItemReduced }}
    >
      {(props.title || props.aside) && (
        <div className="rv-card-head">
          <h2 className="rv-card-title">
            {props.icon && (
              <span className="rv-card-icon" aria-hidden="true">
                {props.icon}
              </span>
            )}
            {props.title}
          </h2>
          {props.aside && <div className="rv-card-aside">{props.aside}</div>}
        </div>
      )}
      {props.children}
    </Card>
  );
}
