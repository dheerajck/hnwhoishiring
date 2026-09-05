const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;
const WORD_CHAR_REGEX = /\w/;

export function escapeRegex(term) {
  return term.replace(REGEX_SPECIAL_CHARS, "\\$&");
}

export function buildWordMatchPattern(term) {
  if (!term) {
    return "";
  }

  let pattern = escapeRegex(term);

  if (WORD_CHAR_REGEX.test(term[0])) {
    pattern = `\\b${pattern}`;
  }

  if (WORD_CHAR_REGEX.test(term[term.length - 1])) {
    pattern = `${pattern}\\b`;
  }

  return pattern;
}

// New parseQuery function - Treats single words as words, multi-word as phrases
export function parseQuery(queryString) {
  const tokens = [];
  // Convert to lowercase FIRST
  const lowerQuery = queryString.toLowerCase().trim();
  // Regex to split by operators (&, |), negation (~), and quotes ("), keeping delimiters
  const parts = lowerQuery.split(/(\s*[&|~]\s*|"[^"]*")/g);

  let i = 0;
  while (i < parts.length) {
    let part = parts[i];
    if (!part || /^\s*$/.test(part)) {
      // Skip empty or whitespace-only parts
      i++;
      continue;
    }

    part = part.trim(); // Trim whitespace from the current part

    if (part === "&" || part === "|") {
      tokens.push(part); // Add operator token
      i++;
    } else if (part === "~") {
      // Handle negation: look ahead for the term/phrase to negate
      let j = i + 1;
      while (j < parts.length && (!parts[j] || /^\s*$/.test(parts[j]))) {
        j++;
      } // Skip whitespace

      if (j < parts.length) {
        let termToNegate = parts[j].trim();
        if (termToNegate.startsWith('"') && termToNegate.endsWith('"')) {
          // Explicitly negated phrase: ~"..."
          tokens.push(`~${termToNegate}`);
        } else {
          // Check if it's a single word or multiple words
          if (termToNegate.includes(" ")) {
            // Implicitly negated phrase (multiple words)
            tokens.push(`~"${termToNegate}"`);
          } else {
            // Negated single word (treat as word, not phrase)
            tokens.push(`~${termToNegate}`); // No quotes added
          }
        }
        i = j + 1; // Move index past the negated term/phrase
      } else {
        i++; // Dangling ~
      }
    } else if (part.startsWith('"') && part.endsWith('"')) {
      // Explicitly quoted phrase: "..."
      tokens.push(part);
      i++;
    } else {
      // Term(s) not explicitly quoted
      if (part.includes(" ")) {
        // Implicit phrase (multiple words)
        tokens.push(`"${part}"`);
      } else {
        // Single word (treat as word, not phrase)
        tokens.push(part); // No quotes added
      }
      i++;
    }
  }
  // Filter out potentially empty tokens
  return tokens.filter(
    (token) => token && token !== '""' && token !== "~" && token !== '~""'
  );
}

// Simplified checkTerm: Returns true if the token's condition is met by the text.
// Handles negation directly based on the token prefix.
export function checkTerm(token, commentText, author, noteText) {
  let isNegated = false;
  let actualTerm = token;
  let isPhrase = false;

  // 1. Determine Negation and Actual Term
  if (actualTerm.startsWith("~")) {
    isNegated = true;
    actualTerm = actualTerm.substring(1);
  }

  // 2. Determine if it's a Phrase
  if (actualTerm.startsWith('"') && actualTerm.endsWith('"')) {
    isPhrase = true;
    actualTerm = actualTerm.substring(1, actualTerm.length - 1);
  }

  // Handle empty terms/phrases after stripping ~, ""
  if (!actualTerm) {
    // An empty positive term "" or word doesn't match anything.
    // An empty negative term ~"" or ~word matches everything.
    return isNegated;
  }

  // 3. Check for Presence
  let termFound = false;
  if (isPhrase) {
    // Exact phrase match
    termFound =
      commentText.includes(actualTerm) ||
      author.includes(actualTerm) ||
      noteText.includes(actualTerm);
  } else {
    // Whole word match (using regex)
    try {
      const regex = new RegExp(buildWordMatchPattern(actualTerm));
      termFound =
        regex.test(commentText) || regex.test(author) || regex.test(noteText);
    } catch (e) {
      // Fallback to simple includes if regex fails (e.g., invalid pattern)
      console.error(`Regex error for term "${actualTerm}":`, e);
      termFound =
        commentText.includes(actualTerm) ||
        author.includes(actualTerm) ||
        noteText.includes(actualTerm);
    }
  }

  // 4. Return final result based on negation
  return isNegated ? !termFound : termFound;
}

// Compiles tokens once into a matcher (commentText, author, noteText) => boolean.
// Inputs must already be lowercase. Returns null when there is nothing to match, so callers
// can skip the query step entirely. Same left-to-right semantics as evaluateQuery.
export function compileQuery(tokens) {
  if (!tokens || tokens.length === 0) return null;

  const steps = tokens.map((token) => {
    if (token === "&" || token === "|") return { op: token };

    let isNegated = false;
    let term = token;
    if (term.startsWith("~")) {
      isNegated = true;
      term = term.substring(1);
    }
    let isPhrase = false;
    if (term.startsWith('"') && term.endsWith('"')) {
      isPhrase = true;
      term = term.substring(1, term.length - 1);
    }
    if (!term) return { test: () => isNegated };

    let regex = null;
    if (!isPhrase) {
      try {
        regex = new RegExp(buildWordMatchPattern(term));
      } catch (e) {
        console.error(`Regex error for term "${term}":`, e);
      }
    }
    const found = regex ? (s) => regex.test(s) : (s) => s.includes(term);
    return {
      test: (commentText, author, noteText) => {
        const hit = found(commentText) || found(author) || found(noteText);
        return isNegated ? !hit : hit;
      },
    };
  });

  return (commentText, author, noteText) => {
    let currentResult = null;
    let nextOperator = "&";
    for (const step of steps) {
      if (step.op) {
        nextOperator = step.op;
        continue;
      }
      const termResult = step.test(commentText, author, noteText);
      if (currentResult === null) {
        currentResult = termResult;
      } else {
        currentResult =
          nextOperator === "|"
            ? currentResult || termResult
            : currentResult && termResult;
        nextOperator = "&";
      }
    }
    return currentResult === null ? true : currentResult;
  };
}

// Updated evaluateQuery for standard boolean logic (left-to-right)
export function evaluateQuery(commentText, author, noteText, tokens) {
  // Ensure inputs are lowercase
  commentText = (commentText || "").toLowerCase();
  author = (author || "").toLowerCase();
  noteText = (noteText || "").toLowerCase();

  if (!tokens || tokens.length === 0) return true; // No query means match all

  let currentResult = null; // Stores the evaluated result so far
  let nextOperator = "&"; // Default operator between terms is AND

  for (const token of tokens) {
    if (token === "&" || token === "|") {
      // Store the explicit operator for the *next* term evaluation
      nextOperator = token;
    } else {
      // It's a term (word, phrase, potentially negated)
      const termResult = checkTerm(token, commentText, author, noteText); // Check if this term's condition is met

      if (currentResult === null) {
        // This is the first term in the expression (or sub-expression)
        currentResult = termResult;
      } else {
        // Apply the stored operator between the previous result and the current term's result
        if (nextOperator === "|") {
          currentResult = currentResult || termResult;
        } else {
          // Operator is '&' (or the default AND)
          currentResult = currentResult && termResult;
        }
        // Reset the operator to default AND for the next pair of terms unless an explicit | or & is found
        nextOperator = "&";
      }
    }
  }
  return currentResult === null ? true : currentResult;
}
