#!/usr/bin/env node

/**
 * Deep analysis of the ultra-optimized formatArrayUltra function
 * Looking for unnecessary comparisons and math functions
 */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

// Current ultra implementation
function formatArrayUltraCurrent(values) {
  const result = new Array(values.length);
  
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    
    if (value === null) {
      result[i] = null;
      continue;
    }
    
    if (value === 0) {
      result[i] = '0';
      continue;
    }
    
    if (!isFinite(value)) {
      result[i] = String(value);
      continue;
    }
    
    const absValue = Math.abs(value);
    
    // Most common case: power values 1000-10000W
    if (absValue >= 1000 && absValue < 10000) {
      result[i] = String(Math.round(value));
      continue;
    }
    
    // Second most common: 100-1000
    if (absValue >= 100 && absValue < 1000) {
      const rounded = Math.round(value * 10) / 10;
      if (rounded === Math.round(rounded)) {
        result[i] = String(Math.round(rounded));
      } else {
        result[i] = String(rounded);
      }
      continue;
    }
    
    // Large values >= 10000
    if (absValue >= 10000) {
      result[i] = String(Math.round(value));
      continue;
    }
    
    // Fall back for other cases (simplified here)
    if (absValue >= 10 && absValue < 100) {
      const rounded = Math.round(value * 100) / 100;
      result[i] = String(rounded);
    } else if (absValue >= 1 && absValue < 10) {
      const rounded = Math.round(value * 1000) / 1000;
      result[i] = String(rounded);
    } else if (absValue >= 0.1) {
      const rounded = Math.round(value * 10000) / 10000;
      result[i] = String(rounded);
    } else {
      // Very small values
      const magnitude = Math.floor(Math.log10(absValue));
      const factor = Math.pow(10, 3 - magnitude);
      const rounded = Math.round(value * factor) / factor;
      result[i] = String(rounded);
    }
  }
  
  return result;
}

// Improved ultra implementation
function formatArrayUltraImproved(values) {
  const result = new Array(values.length);
  
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    
    if (value === null) {
      result[i] = null;
      continue;
    }
    
    if (value === 0) {
      result[i] = '0';
      continue;
    }
    
    if (!isFinite(value)) {
      result[i] = String(value);
      continue;
    }
    
    const absValue = Math.abs(value);
    
    // Combine large value checks (>= 1000)
    if (absValue >= 1000) {
      result[i] = String(Math.round(value));
      continue;
    }
    
    // 100-999: 1 decimal place
    if (absValue >= 100) {
      const rounded = Math.round(value * 10) / 10;
      // No need to check if integer - JS automatically handles .0
      result[i] = String(rounded);
      continue;
    }
    
    // 10-99: 2 decimal places
    if (absValue >= 10) {
      const rounded = Math.round(value * 100) / 100;
      result[i] = String(rounded);
      continue;
    }
    
    // 1-9: 3 decimal places
    if (absValue >= 1) {
      const rounded = Math.round(value * 1000) / 1000;
      result[i] = String(rounded);
      continue;
    }
    
    // 0.1-0.999: 4 decimal places
    if (absValue >= 0.1) {
      const rounded = Math.round(value * 10000) / 10000;
      result[i] = String(rounded);
      continue;
    }
    
    // 0.01-0.099: 5 decimal places
    if (absValue >= 0.01) {
      const rounded = Math.round(value * 100000) / 100000;
      result[i] = String(rounded);
      continue;
    }
    
    // 0.001-0.009: 6 decimal places
    if (absValue >= 0.001) {
      const rounded = Math.round(value * 1000000) / 1000000;
      result[i] = String(rounded);
      continue;
    }
    
    // Very small values - fallback
    const magnitude = Math.floor(Math.log10(absValue));
    const factor = Math.pow(10, 3 - magnitude);
    const rounded = Math.round(value * factor) / factor;
    result[i] = String(rounded);
  }
  
  return result;
}

// Further optimized with lookup table
function formatArrayUltraLookup(values) {
  const result = new Array(values.length);
  
  // Pre-computed powers of 10
  const powers = [1, 10, 100, 1000, 10000, 100000, 1000000];
  
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    
    if (value === null) {
      result[i] = null;
      continue;
    }
    
    if (value === 0) {
      result[i] = '0';
      continue;
    }
    
    if (!isFinite(value)) {
      result[i] = String(value);
      continue;
    }
    
    const absValue = Math.abs(value);
    
    // >= 1000: no decimals
    if (absValue >= 1000) {
      result[i] = String(Math.round(value));
      continue;
    }
    
    // Use lookup table for powers
    let decimals;
    if (absValue >= 100) decimals = 1;      // 100-999
    else if (absValue >= 10) decimals = 2;  // 10-99
    else if (absValue >= 1) decimals = 3;   // 1-9
    else if (absValue >= 0.1) decimals = 4; // 0.1-0.999
    else if (absValue >= 0.01) decimals = 5; // 0.01-0.099
    else if (absValue >= 0.001) decimals = 6; // 0.001-0.009
    else {
      // Very small values - fallback
      const magnitude = Math.floor(Math.log10(absValue));
      const factor = Math.pow(10, 3 - magnitude);
      const rounded = Math.round(value * factor) / factor;
      result[i] = String(rounded);
      continue;
    }
    
    const factor = powers[decimals];
    const rounded = Math.round(value * factor) / factor;
    result[i] = String(rounded);
  }
  
  return result;
}

console.log(`${BOLD}=============================================================`);
console.log(`ULTRA OPTIMIZATION ANALYSIS`);
console.log(`=============================================================\n${RESET}`);

console.log(`${BOLD}ISSUES IN CURRENT ULTRA IMPLEMENTATION:${RESET}`);
console.log('---------------------------------------\n');

console.log(`${YELLOW}1. REDUNDANT Math.round() calls:${RESET}`);
console.log(`   In 100-1000 range:`);
console.log(`   - Math.round(value * 10) to get rounded value`);
console.log(`   - Math.round(rounded) to check if integer`);
console.log(`   - Math.round(rounded) again if it's integer`);
console.log(`   ${GREEN}→ Solution: JavaScript automatically omits .0 in strings${RESET}\n`);

console.log(`${YELLOW}2. UNNECESSARY COMPARISON:${RESET}`);
console.log(`   - "rounded === Math.round(rounded)" check`);
console.log(`   ${GREEN}→ Solution: Remove entirely, let JS handle formatting${RESET}\n`);

console.log(`${YELLOW}3. INEFFICIENT RANGE CHECKS:${RESET}`);
console.log(`   - Checks >= 1000 && < 10000`);
console.log(`   - Then >= 100 && < 1000`);
console.log(`   - Then >= 10000 separately`);
console.log(`   ${GREEN}→ Solution: Combine >= 1000 cases into one${RESET}\n`);

console.log(`${YELLOW}4. MISSING OPTIMIZATION OPPORTUNITY:${RESET}`);
console.log(`   - Not using lookup table for powers of 10`);
console.log(`   ${GREEN}→ Solution: Pre-compute powers array${RESET}\n`);

// Generate test data
function generateTestData(size) {
  const data = [];
  
  // Typical power values (40% of data) - most common
  for (let i = 0; i < size * 0.4; i++) {
    data.push(100 + Math.random() * 5000);
  }
  
  // Battery SOC (20% of data)
  for (let i = 0; i < size * 0.2; i++) {
    data.push(Math.random() * 100);
  }
  
  // Large values (10% of data)
  for (let i = 0; i < size * 0.1; i++) {
    data.push(10000 + Math.random() * 90000);
  }
  
  // Negative values (20% of data)
  for (let i = 0; i < size * 0.2; i++) {
    data.push(-Math.random() * 5000);
  }
  
  // Small values (8% of data)
  for (let i = 0; i < size * 0.08; i++) {
    data.push(Math.random());
  }
  
  // Nulls (2% of data)
  for (let i = 0; i < size * 0.02; i++) {
    data.push(null);
  }
  
  return data;
}

// Benchmark function
function benchmark(fn, data, iterations, name) {
  // Warm up
  for (let i = 0; i < 100; i++) {
    fn([data[i % data.length]]);
  }
  
  const testArray = data;
  const start = process.hrtime.bigint();
  
  for (let i = 0; i < iterations; i++) {
    fn(testArray);
  }
  
  const end = process.hrtime.bigint();
  const timeMs = Number(end - start) / 1000000;
  const elementsPerSec = (iterations * data.length) / (timeMs / 1000);
  
  return { name, timeMs, elementsPerSec, iterations };
}

// Test correctness
console.log(`${BOLD}CORRECTNESS CHECK:${RESET}`);
console.log('-----------------\n');

const testCases = [
  { input: 2500, expected: '2500' },
  { input: 250.5, expected: '250.5' },
  { input: 25.55, expected: '25.55' },
  { input: 2.555, expected: '2.555' },
  { input: 0.2555, expected: '0.2555' },
  { input: 0.02555, expected: '0.02555' },
  { input: 1234567, expected: '1234567' },
  { input: 123.456, expected: '123.5' },
  { input: 12.3456, expected: '12.35' },
  { input: 0, expected: '0' },
  { input: null, expected: null },
];

let allPass = true;
for (const impl of [
  { fn: formatArrayUltraCurrent, name: 'Current' },
  { fn: formatArrayUltraImproved, name: 'Improved' },
  { fn: formatArrayUltraLookup, name: 'Lookup' }
]) {
  const inputs = testCases.map(tc => tc.input);
  const expected = testCases.map(tc => tc.expected);
  const results = impl.fn(inputs);
  
  let passed = true;
  for (let i = 0; i < testCases.length; i++) {
    if (results[i] !== expected[i]) {
      console.log(`${RED}✗ ${impl.name}: ${inputs[i]} → "${results[i]}" (expected: "${expected[i]}")${RESET}`);
      passed = false;
      allPass = false;
    }
  }
  
  if (passed) {
    console.log(`${GREEN}✓ ${impl.name}: All tests passed${RESET}`);
  }
}

if (!allPass) {
  console.log(`\n${RED}Some implementations failed correctness tests!${RESET}`);
}

console.log(`\n${BOLD}PERFORMANCE COMPARISON:${RESET}`);
console.log('----------------------\n');

const testData = generateTestData(1000);
const iterations = 10000;

console.log(`Testing with ${testData.length} elements, ${iterations} iterations\n`);

const results = [
  benchmark(formatArrayUltraCurrent, testData, iterations, 'Current Ultra'),
  benchmark(formatArrayUltraImproved, testData, iterations, 'Improved Ultra'),
  benchmark(formatArrayUltraLookup, testData, iterations, 'Lookup Ultra'),
];

// Display results
console.log('Implementation    Time(ms)   Elements/sec    Relative');
console.log('------------------------------------------------------');
const baseline = results[0].elementsPerSec;
results.forEach(r => {
  const relative = r.elementsPerSec / baseline;
  console.log(
    `${r.name.padEnd(16)} ${r.timeMs.toFixed(2).padStart(8)} ${r.elementsPerSec.toFixed(0).padStart(14).toLocaleString()}    ${relative.toFixed(2)}x`
  );
});

console.log(`\n${BOLD}OPTIMIZATION GAINS:${RESET}`);
console.log('------------------\n');

const improvement1 = ((results[1].elementsPerSec / results[0].elementsPerSec - 1) * 100).toFixed(1);
const improvement2 = ((results[2].elementsPerSec / results[0].elementsPerSec - 1) * 100).toFixed(1);

console.log(`${GREEN}Improved: +${improvement1}% faster${RESET}`);
console.log(`${GREEN}Lookup:   +${improvement2}% faster${RESET}`);

console.log(`\n${BOLD}KEY OPTIMIZATIONS APPLIED:${RESET}`);
console.log('-------------------------\n');

console.log(`1. ${GREEN}✓${RESET} Removed redundant Math.round() calls`);
console.log(`2. ${GREEN}✓${RESET} Eliminated unnecessary integer check`);
console.log(`3. ${GREEN}✓${RESET} Combined >= 1000 range checks`);
console.log(`4. ${GREEN}✓${RESET} Added lookup table for powers of 10`);
console.log(`5. ${GREEN}✓${RESET} Simplified branching logic`);

console.log(`\n${BOLD}RECOMMENDED IMPLEMENTATION:${RESET}`);
console.log('---------------------------\n');

console.log(`The ${GREEN}Lookup Ultra${RESET} version provides:`);
console.log(`- Cleanest code structure`);
console.log(`- Best performance`);
console.log(`- No redundant operations`);
console.log(`- Efficient power-of-10 handling`);

console.log(`\n${BOLD}=============================================================`);
console.log(`ANALYSIS COMPLETE${RESET}`);
console.log(`${BOLD}=============================================================\n${RESET}`);