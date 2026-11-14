import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, FileCheck2, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "../design/Button";
import { ErrorNotice } from "../components/ErrorNotice";
import { fadeUp, fadeOnly, stagger } from "../design/motion";
import { Logo } from "./Logo";

export function SignIn({ identity, busy, error, onSignIn }: { identity: string; busy: boolean; error: unknown; onSignIn: () => void }) {
  const reduce = useReducedMotion();
  const item = reduce ? fadeOnly : fadeUp;
  return (
    <div className="signin-wrap">
      <motion.section
        className="signin-card"
        aria-labelledby="signin-heading"
        variants={stagger}
        initial="hidden"
        animate="show"
      >
        <motion.div variants={item} className="signin-logo">
          <span className="signin-logo-halo" aria-hidden="true" />
          <Logo size={52} />
        </motion.div>
        <motion.p variants={item} className="ds-eyebrow">
          Vexo Field Assistant
        </motion.p>
        <motion.h1 variants={item} id="signin-heading" className="signin-title">
          Visit notes that <span className="grad-text">write themselves</span>.
        </motion.h1>
        <motion.p variants={item} className="muted signin-sub">
          This is synthetic development authentication. It signs you in as a fictional demo provider (
          <span className="mono">{identity}</span>) and is not available in production.
        </motion.p>
        <motion.ul variants={item} className="signin-points">
          <li>
            <Sparkles size={16} aria-hidden="true" /> AI-drafted notes from visit evidence
          </li>
          <li>
            <ShieldCheck size={16} aria-hidden="true" /> You review and approve every word
          </li>
          <li>
            <FileCheck2 size={16} aria-hidden="true" /> Invoices and records, ready to send
          </li>
        </motion.ul>
        {error != null && (
          <motion.div variants={item}>
            <ErrorNotice title="Sign-in failed" error={error} />
          </motion.div>
        )}
        <motion.div variants={item}>
          <Button variant="primary" block loading={busy} onClick={onSignIn} iconRight={busy ? undefined : <ArrowRight size={16} />} style={{ height: 46 }}>
            {busy ? "Signing in…" : "Sign in as demo provider"}
          </Button>
        </motion.div>
      </motion.section>
    </div>
  );
}
