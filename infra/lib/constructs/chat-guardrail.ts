/**
 * chat-guardrail.ts  -  Amazon Bedrock Guardrails: one cheap check in front of the model.
 *
 * WHAT IS CONFIGURED
 *   One policy: the PROMPT_ATTACK content filter at HIGH strength, on the INPUT only. It catches users who try to
 *   override the system prompt ("ignore your instructions and ..."). The filter does not apply to model output
 *   (`outputStrength` must be NONE for this filter type).
 *
 * WHY SO LITTLE
 *   Each guardrail filter is billed per 1,000 characters it checks (a "text unit"). Checking only what users type, once per
 *   question, keeps the cost to a fraction of a cent. Output PII masking, contextual-grounding checks and scanning of
 *   retrieved text are all possible later, and each one adds cost. See ARCHITECTURE.md section 6.
 *
 * WHAT COVERS THE REST
 *   Uploaded documents are untrusted text that can contain instructions (indirect prompt injection). In this design the agent
 *   has read-only tools and cannot change anything, so the worst case is a bad answer, not a bad action.
 *
 * KEY CONCEPTS / TRAPS
 *   - A guardrail has a mutable DRAFT and immutable numbered VERSIONS. The agent uses a pinned VERSION, so editing the draft
 *     cannot silently change behaviour in production.
 *   - `GuardrailVersion` properties are create-only: changing one means REPLACEMENT, which creates a new version. The version
 *     description therefore embeds a hash of the guardrail configuration. Edit the configuration and the hash changes, so a new
 *     version is created and the agent is pointed at it. Without this, an edited guardrail would keep serving the old snapshot.
 *   - The guardrail is applied by the CALLER: the agent passes its id and version to the model. The agent's role therefore
 *     needs `bedrock:ApplyGuardrail` on this guardrail.
 */
import { createHash } from 'crypto';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import { Construct } from 'constructs';
import { ChatGuardrailProps } from '../props/agent-props';

export class ChatGuardrail extends Construct {
  public readonly guardrailId: string;
  public readonly guardrailArn: string;
  /** Pinned numeric version, for example "1". */
  public readonly guardrailVersion: string;

  constructor(scope: Construct, id: string, props: ChatGuardrailProps) {
    super(scope, id);

    const contentPolicyConfig = {
      filtersConfig: [{ type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' }],
    };

    const guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
      name: props.name,
      description: 'Screens user input for prompt-injection attempts before it reaches the model.',
      blockedInputMessaging: props.blockedMessage,
      blockedOutputsMessaging: props.blockedMessage,
      contentPolicyConfig,
    });

    // See "KEY CONCEPTS / TRAPS": a change in configuration must produce a new, pinned version.
    const configHash = createHash('sha256')
      .update(JSON.stringify({ contentPolicyConfig, message: props.blockedMessage }))
      .digest('hex')
      .substring(0, 12);
    const version = new bedrock.CfnGuardrailVersion(this, 'GuardrailVersion', {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: `Pinned snapshot, config ${configHash}`, // at most 200 characters
    });

    this.guardrailId = guardrail.attrGuardrailId;
    this.guardrailArn = guardrail.attrGuardrailArn;
    this.guardrailVersion = version.attrVersion;
  }
}
