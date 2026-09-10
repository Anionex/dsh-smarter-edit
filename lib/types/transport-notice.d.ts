/**
 * One-time notice for sessions whose model route cannot carry the freeform
 * `apply_patch` transport.
 *
 * Which route a session uses is the user's provider configuration, not this
 * plugin's decision, so a route without the freeform boundary is not an error.
 * It is, however, invisible: the same tool name travels as an ordinary JSON
 * function tool and nothing else changes. Saying so once — instead of never —
 * is the difference between a user knowing their configuration and assuming
 * the recommended one is already active.
 */
export declare const FREEFORM_SETUP_URL = "https://github.com/Anionex/dsh-smarter-edit#recommended-configuration";
export declare const FALLBACK_TRANSPORT_NOTICE: string;
export interface FallbackNoticeInput {
    /** Provider id the session routes through, when the session header exposes one. */
    provider: string | undefined;
    /** Whether any request for that provider was observed on the freeform-capable adapter. */
    freeformCapable: boolean;
    /** Config switch; deployments that deliberately run the fallback can turn this off. */
    enabled: boolean;
    /** Whether this session has already produced the notice. */
    alreadyNotified: boolean;
}
/**
 * Decide whether one tool result should carry the fallback notice.
 *
 * An unknown provider is treated as "cannot confirm freeform", because a
 * missing session header must not be reported as the recommended setup.
 */
export declare function shouldShowFallbackNotice(input: FallbackNoticeInput): boolean;
