/**
 * The product's ASCII art, for the console: the "DAS FORGE" wordmark (start-up banner) and the round logo.
 * Plain lines of text, no colour codes, so they survive logs and any terminal. Lines are right-trimmed and
 * share no common left indent.
 */

/** The "DAS FORGE" lettering, one array item per line. */
export const DAS_FORGE_WORDMARK = Object.freeze([
  "                            :.                        ::                        :.",
  "MMVVFMMMM       MMM      MMN$$MM        MMNNNNN   $MMN$$MMM:   IMMVVMMM.    MMMN$$MMM   NMNVVVVV",
  "MM     .MM     MM.MM    *M$             MM       FM$      MM*  IMF    MM   MM           NM:",
  "MM      FM$   VM: MM     MMM            MM       MM       .MM  IMF   *MM  MM*           NM:",
  "MM      *MM   MM   MM     :MMMM         MMMMMMM  MM        MM  IMMMMMN    MM    MMMMM   NMMMMMM",
  "MM      NM*  MMVVVVMMM        MMI       MM       MM       .MM  IMF  :MM   MM*      MM   NM:",
  "MM     .MM  *MF     MM        IMV       MM       MMI      MM   IMF   :MM   MM      MM   NM:",
  "MMMMMMMMV   MM       MM MMMMMMMM        MM        VMMMMMMMM    IMF    MM.   MMMMMMMMM   NMMMMMMM",
  "                           ..                        ...                        .."
]);

/** The round logo, one array item per line. */
export const DAS_FORGE_LOGO = Object.freeze([
  "                                VF .FV",
  "                             IN  .NN.  N*",
  "                         *FV .FV      VF  FF*",
  "                      :NF .$N            N$. FF:",
  "               INN .N* $FI                  IF$ *N  NNI",
  "               *FN  IN*                        VNI  NN*",
  "            .N*. FN*                              *N$ .VN",
  "         NF*  NV:                                    :V$  $NV",
  "      :.  NN.                                            .N.  ..",
  "      .  .                                                  V  :",
  "                    ................................................",
  "MMMMMMMMMMMMMMMMMMMM:                                              F",
  " M I:I*III**II$ V NM N. ..  N N:.M  M.N N... .. N  M.N:.. ..  .  .I",
  " :M      .:.I*$ M    M $$$FV .N.VF. N.$I.M$$$$$$$$* :$I        .I.",
  "   .MM          M    M.....FNVM.M I. M M MM.      .   .    :*M.",
  "      .M.       M    M.      F.  .NN.  :$ MMMMMMMM     VM:     .",
  "      *   MFIM       M.      VVIVV$$VV*VV $VNNMM  VVM       .  .",
  "      *  .       .IM:       M    NNNN    M     .MI          :  .",
  "      *  .           FM  ...$M.M  NN  M.M*:.. MI            :  .",
  "      *  .             VM MM M.N.  . FN:M M. M.             :  .",
  "      *  .              M *MV.M:V    N.M*IM MM              :  .",
  "      : $.              M :MV.M:     .:M*$M MM              :I .",
  "      :.                M :MV.MI.    .*M*IM  M                :*",
  "   :N$:  .            M.  MIMM I.    .::MMIM  $M            *  .VN.",
  "      .          .MM.    . F             .N $    .MM.       .  .",
  "      I  .       M  MMMMMMF     MMMMMM     MMMMVMM  M       :  :",
  "      *  .       M          $M.        .M:          N       .  .",
  "      :  N.      M        VM  :MMMMMMMM:  M$        M      .N  .",
  "       N$  .N$   MNMMMMFMMMNM           .MMFMMM$MMMMM  .$N   $N",
  "         :NN  :F$                                    $N:  N:.",
  "             FN: $FV                              VF  :FF",
  "                 V.   F                       .N.  .N",
  "                F$: V  :I*                  NI: $N.:$N",
  "                      .N$  IN:          *F.  $N",
  "                         :VF  .VN    N$.  NV:",
  "                             N$   NN   IN",
  "                                IN .NI"
]);

const INDENT = '  ';
const center = (lines, width) => {
  const w = Math.max(...lines.map((r) => [...r].length));
  return lines.map((r) => ' '.repeat(Math.floor((width - w) / 2)) + r);
};

/**
 * Start-up banner text, every line indented by two spaces. Top to bottom: the logo, a line of "=", the "DAS FORGE"
 * lettering (both centred), a line of "=", the given rows, a line of "=". One empty line sits above and below every
 * block so nothing touches the lines of "=".
 * Pure: returns the text, the caller prints it.
 * @param {string[]} rows - the lines under the lettering
 * @param {{wordmark?: boolean, logo?: boolean}} [o] - `logo: false` leaves the tall round logo out
 * @returns {string}
 */
export function renderBanner(rows, { wordmark = true, logo = true } = {}) {
  const blocks = [];
  if (logo) blocks.push(DAS_FORGE_LOGO);
  if (wordmark) blocks.push(DAS_FORGE_WORDMARK);
  const width = Math.max(1, ...blocks.flat().map((r) => [...r].length), ...rows.map((r) => [...r].length));
  const bar = '='.repeat(width);
  const out = [];
  for (const b of blocks) out.push('', ...center(b, width), '', bar);
  out.push('', ...rows, '', bar);
  return out.map((l) => (l ? INDENT + l : l)).join('\n');
}
