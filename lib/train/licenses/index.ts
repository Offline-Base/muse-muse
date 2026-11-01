/**
 * The files every Derivative of Muse Spark Open ships with (lib/train/base.ts): r30b's own license files, byte for byte
 * as the knowledge branch has them in docs/model-licenses/stage-b-r30b/ (committed beside this file, with their sha256
 * pinned in lib/train/__tests__/base.test.ts). LICENSE is Meta's Apache 2.0, MUSE_MODEL_LICENSE.md the Muse Model License
 * with its Exhibit A Usage Policy, USAGE_POLICY.md the Muse Glimmer Usage Policy, and NOTICE r30b's notice of what was
 * changed, which Apache 2.0 section 4(d) asks every work built on it to carry. The text is here as strings, so the Hub
 * steps and the drive image need no file reads at run time. Server code only: it is about 26 KB.
 */

/** One license file: its name in a repo or on a drive, its bytes as text, and their sha256. */
export interface LicenseFile {
  path: string;
  text: string;
  sha256: string;
}

const APACHE_LICENSE = String.raw`
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
`;

const MUSE_MODEL_LICENSE = String.raw`**MUSE MODEL LICENSE**

*version: Muse Spark Open*

*Release date: October 15, 2026*

Copyright (c) 2026 Meta Platforms, Inc.

Permission is hereby granted, free of charge, to any person (the "Licensee") accessing or obtaining a copy of this software, including the model, code, model weights, parameters, configuration files, and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation, the rights to use, copy, modify (including fine-tune), create derivative works, distill, merge, publish, distribute, sublicense, and/or sell copies of the Software; and to permit persons to whom the Software is furnished to do so, in each case subject to the following conditions:

1\.     The above copyright notice and this license and the Usage Policy shall be included in all copies or substantial portions of the Software and Derivatives (defined below). Licensee's use of the Software shall comply with the Usage Policy, which is hereby incorporated into this license and attached hereto as Exhibit A.

2\.     Licensee shall prominently display "Built with Muse Spark Open" in the user interface of each product or service that uses the Software or any Derivatives, or in the accompanying documentation, website, or settings menu. “Derivatives” means any AI model created, trained, modified (including fine-tuned), distilled, or otherwise improved using the Software or any outputs or results thereof.

3\.     If the Licensee or any of its affiliates provide a third party with access to artificial intelligence models as a product or service, via API or a similar interface, where the third party receives outputs of such models (“**Model as a Service**”), and the aggregate gross revenue of the Licensee and its affiliates exceeds twenty (20) million US dollars (or the equivalent in other currencies) during any consecutive twelve (12) month period, the Licensee must notify Meta and enter into a separate written agreement with Meta before offering the Software or any Derivatives as part of that Model as a Service business. This Section 3 does not apply to (a) internal use, research, or any commercial activity that is not Model as a Service, or (b) the Licensee's use of the Software as a component to power features of the Licensee's own product or service that is not a Model as a Service. 

4\.   Meta claims no ownership of outputs generated by the Software.

5\.     THE SOFTWARE, ANY OUTPUTS, AND ANY RESULTS THEREFROM ARE PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL META OR ITS AFFILIATES BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR ITS OUTPUTS, OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. META AND ITS AFFILIATES SHALL HAVE NO LIABILITY WITH RESPECT TO ANY DERIVATIVES, AND LICENSEE IS SOLELY RESPONSIBLE FOR THE SAFETY, DEPLOYMENT, AND USE OF ITS DERIVATIVES.

“Meta” means Meta Platforms Ireland Limited (if you are located in or, if you are an entity, your principal place of business is in the European region) and Meta Platforms, Inc. (if you are located outside of the European region). 

**EXHIBIT A \- Muse Spark Open Usage Policy**

Dated: October 15, 2026

Meta is committed to promoting safe and fair use of its tools and features, including Muse Spark Open. This Usage Policy (“Policy”) applies to your access or use of Muse Spark Open and any Derivatives.

Prohibited Uses

We want everyone to use Muse Spark Open safely and responsibly. It is your obligation to ensure that any deployment of the model to end-users is safe, taking into account the deployment context and the user-base. Muse Spark Open is not intended for individuals under the age of 18\.

You should not use, or allow others to use, Muse Spark Open to:

1. Violate the law or others' rights, including to:  
   1. Engage in, promote, generate, contribute to, encourage, plan, incite, or further illegal or unlawful activity or content, such as:  
      1. Violence or terrorism  
      2. Exploitation or harm to children, including the solicitation, creation, acquisition, or dissemination of child exploitative content or failure to report Child Sexual Abuse Material  
      3. Human trafficking, exploitation, and sexual violence  
      4. The illegal distribution of information or materials to minors, including obscene materials, or failure to employ legally required age-gating in connection with such information or materials  
      5. Sexual solicitation  
      6. Any other criminal activity  
   2. Engage in, promote, incite, or facilitate the harassment, abuse, threatening, or bullying of individuals or groups of individuals  
   3. Engage in, promote, incite, or facilitate discrimination or other unlawful or harmful conduct in the provision of employment, employment benefits, credit, housing, other economic benefits, or other essential goods and services  
   4. Engage in the unauthorized or unlicensed practice of any profession including, but not limited to, financial, legal, medical/health, or related professional practices  
   5. Collect, process, disclose, generate, or infer private or sensitive information about individuals, including information about individuals' identity, health, or demographic information, unless you have obtained the right to do so in accordance with applicable law  
   6. Engage in or facilitate any action or generate any content that infringes, misappropriates, or otherwise violates any third-party rights, including the outputs or results of any products or services using Muse Spark Open  
   7. Create, generate, or facilitate the creation of malicious code, malware, computer viruses or do anything else that could disable, overburden, interfere with or impair the proper working, integrity, operation or appearance of a website or computer system  
   8. Engage in any action, or facilitate any action, to intentionally circumvent or remove usage restrictions or other safety measures, or to enable functionality disabled by Meta  
2. Engage in, promote, incite, facilitate, or assist in the planning or development of activities that present a risk of death or bodily harm to individuals, including use of Muse Spark Open related to the following:  
   1. Military, warfare, nuclear industries or applications, espionage, use for materials or activities that are subject to the International Traffic Arms Regulations (ITAR) maintained by the United States Department of State or to the U.S. Biological Weapons Anti-Terrorism Act of 1989 or the Chemical Weapons Convention Implementation Act of 1997  
   2. Guns and illegal weapons (including weapon development)  
   3. Illegal drugs and regulated/controlled substances  
   4. Operation of critical infrastructure, transportation technologies, or heavy machinery  
   5. Self-harm or harm to others, including suicide, cutting, and eating disorders  
   6. Any content intended to incite or promote violence, abuse, or any infliction of bodily harm to an individual  
3. Intentionally deceive or mislead others, including use of Muse Spark Open related to the following:  
   1. Generating, promoting, or furthering fraud or the creation or promotion of disinformation  
   2. Generating, promoting, or furthering defamatory content, including the creation of defamatory statements, images, or other content  
   3. Generating, promoting, or further distributing spam  
   4. Impersonating another individual without consent, authorization, or legal right  
   5. Representing that the use of Muse Spark Open or outputs are human generated  
   6. Generating or facilitating false online engagement, including fake reviews and other means of fake online engagement  
4. Fail to appropriately disclose to end users any known dangers of your AI system  
5. Interact with third party tools, models, or software designed to generate unlawful content or engage in unlawful or harmful conduct and/or represent that the outputs of such tools, models, or software are associated with Meta or Muse Spark Open
`;

const USAGE_POLICY = String.raw`# Muse Glimmer Usage Policy

Meta is committed to promoting safe and fair use of its tools and features, including Muse Glimmer. This Usage Policy (“Policy”) applies to your access or use of Muse Glimmer. The most recent copy of this policy can be found at: [https://huggingface.co/meta-models/Muse-Glimmer-30B/blob/main/USAGE\_POLICY](https://huggingface.co/meta-models/Muse-Glimmer-30B/blob/main/USAGE_POLICY.md)

## Prohibited Uses

We want everyone to use Muse Glimmer safely and responsibly. Muse Glimmer is not intended for individuals under the age of 18\.

You should not use, or allow others to use, Muse Glimmer to:

1. **Violate the law or others' rights, including to:**
   1. Engage in, promote, generate, contribute to, encourage, plan, incite, or further illegal or unlawful activity or content, such as:
      1. Violence or terrorism
      2. Exploitation or harm to children, including the solicitation, creation, acquisition, or dissemination of child exploitative content or failure to report Child Sexual Abuse Material
      3. Human trafficking, exploitation, and sexual violence
      4. The illegal distribution of information or materials to minors, including obscene materials, or failure to employ legally required age-gating in connection with such information or materials
      5. Sexual solicitation
      6. Any other criminal activity
   2. Engage in, promote, incite, or facilitate the harassment, abuse, threatening, or bullying of individuals or groups of individuals
   3. Engage in, promote, incite, or facilitate discrimination or other unlawful or harmful conduct in the provision of employment, employment benefits, credit, housing, other economic benefits, or other essential goods and services
   4. Engage in the unauthorized or unlicensed practice of any profession including, but not limited to, financial, legal, medical/health, or related professional practices
   5. Collect, process, disclose, generate, or infer private or sensitive information about individuals, including information about individuals' identity, health, or demographic information, unless you have obtained the right to do so in accordance with applicable law
   6. Engage in or facilitate any action or generate any content that infringes, misappropriates, or otherwise violates any third-party rights, including the outputs or results of any products or services using Muse Glimmer
   7. Create, generate, or facilitate the creation of malicious code, malware, computer viruses or do anything else that could disable, overburden, interfere with or impair the proper working, integrity, operation or appearance of a website or computer system
   8. Engage in any action, or facilitate any action, to intentionally circumvent or remove usage restrictions or other safety measures, or to enable functionality disabled by Meta
2. **Engage in, promote, incite, facilitate, or assist in the planning or development of activities that present a risk of death or bodily harm to individuals, including use of Muse Glimmer related to the following:**
   1. Military, warfare, nuclear industries or applications, espionage, use for materials or activities that are subject to the International Traffic Arms Regulations (ITAR) maintained by the United States Department of State or to the U.S. Biological Weapons Anti-Terrorism Act of 1989 or the Chemical Weapons Convention Implementation Act of 1997
   2. Guns and illegal weapons (including weapon development)
   3. Illegal drugs and regulated/controlled substances
   4. Operation of critical infrastructure, transportation technologies, or heavy machinery
   5. Self-harm or harm to others, including suicide, cutting, and eating disorders
   6. Any content intended to incite or promote violence, abuse, or any infliction of bodily harm to an individual
3. **Intentionally deceive or mislead others, including use of Muse Glimmer related to the following:**
   1. Generating, promoting, or furthering fraud or the creation or promotion of disinformation
   2. Generating, promoting, or furthering defamatory content, including the creation of defamatory statements, images, or other content
   3. Generating, promoting, or further distributing spam
   4. Impersonating another individual without consent, authorization, or legal right
   5. Representing that the use of Muse Glimmer or outputs are human generated
   6. Generating or facilitating false online engagement, including fake reviews and other means of fake online engagement
4. **Fail to appropriately disclose to end users any known dangers of your AI system**
5. **Interact with third party tools, models, or software designed to generate unlawful content or engage in unlawful or harmful conduct and/or represent that the outputs of such tools, models, or software are associated with Meta or Muse Glimmer**

Please report any violation of this Policy, software "bug," or other problems that could lead to a violation of this Policy through one of the following means:

* Reporting issues with the model: [https://huggingface.co/meta-models/](https://huggingface.co/meta-models/)
* Reporting bugs and security concerns: [https://facebook.com/whitehat/info](https://facebook.com/whitehat/info)
`;

const R30B_NOTICE = String.raw`Glimmer-30B-2026-Knowledge-GGUF
Copyright 2026 OfflineBase

Built with Muse Spark Open.

This product is a fine-tune of Muse Glimmer 30B (meta-models/Muse-Glimmer-30B,
revision cec94fcfd6512f2cfe708138c32533b346ea4f69), licensed by Meta under the Apache
License, Version 2.0 (see LICENSE).

What we changed:
- We trained LoRA weights (rank 64) on the language model's projection layers. The
  merged and quantized GGUF files in this repo include them. The adapter itself is in
  Glimmer-30B-2026-Knowledge-LoRA, and the merged BF16 weights in Glimmer-30B-2026-Knowledge.
- We did not change the vision encoder, the tokenizer or the model configuration.
- tuned-reasoning-off.jinja is modified from Meta's chat_template.jinja. Unless
  allow_reasoning is set, it opens the reply to the user, with no reasoning channel and
  no tool calls.

Part of the training data was written by Muse Spark Open, so this model is a Derivative
under the Muse Model License (see MUSE_MODEL_LICENSE.md, Exhibit A: Muse Spark Open Usage
Policy). Use of this model must also follow the Muse Glimmer Usage Policy (USAGE_POLICY.md).

Our modifications are licensed under the Apache License, Version 2.0 (see LICENSE).

This is not an official Meta release and is not endorsed by Meta. The names Muse, Muse
Glimmer and Muse Spark appear only to say what this model is built on.
`;

/** In the order a repo lists them. The Hub's model repos and the drive get all four. */
export const DERIVATIVE_FILES: readonly LicenseFile[] = [
  { path: "LICENSE", text: APACHE_LICENSE, sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30" },
  { path: "MUSE_MODEL_LICENSE.md", text: MUSE_MODEL_LICENSE, sha256: "458a5c57d8e622e395eb0e59799ba5bba1ea7524ffd120ee6e3018688d7d6ace" },
  { path: "USAGE_POLICY.md", text: USAGE_POLICY, sha256: "98a14dab9fd97de1666dc8589d399efab1e7fc3ba4e6230d037d6637ba9481d3" },
  { path: "NOTICE", text: R30B_NOTICE, sha256: "c2f0d43b33078582edc3ec254a8adfc620cacc0433093bc33922b7ea70048e69" },
];
