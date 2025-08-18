#!/usr/bin/env node

/**
 * Unified profiling and testing suite for formatPrecision function
 * Tests array-based processing: number[] → string[]
 * 
 * OpenNEM Specification: https://github.com/opennem/opennem/issues/446
 * - Exactly 4 significant figures
 * - Preserve all digits left of decimal point
 * - Include decimals only when precision is needed
 * - Remove trailing zeros after decimal place
 * - Output must be string format
 */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

// Helper function for single value formatting (current implementation)
function formatSingleCurrent(value) {
  if (value === 0) {
    return '0';
  }
  
  // Handle special values
  if (!isFinite(value)) {
    return String(value);
  }
  
  // Calculate the order of magnitude
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  
  // For large integers (magnitude >= 4), preserve all digits
  if (magnitude >= 4) {
    return String(Math.round(value));
  }
  
  // Calculate decimal places needed for 4 significant figures
  const decimalPlaces = Math.max(0, 3 - magnitude);
  
  // Round to 4 significant figures
  const factor = Math.pow(10, decimalPlaces);
  const rounded = Math.round(value * factor) / factor;
  
  // If it's effectively an integer, return as integer string
  if (Math.abs(rounded - Math.round(rounded)) < 1e-10) {
    return String(Math.round(rounded));
  }
  
  // Format with appropriate decimal places and remove trailing zeros
  let result = rounded.toFixed(decimalPlaces);
  
  // Remove trailing zeros after decimal point
  if (result.includes('.')) {
    result = result.replace(/\.?0+$/, '');
  }
  
  return result;
}

// Helper function for single value formatting (optimized implementation)
function formatSingleOptimized(value) {
  if (value === 0) {
    return '0';
  }
  
  // Handle special values
  if (!isFinite(value)) {
    return String(value);
  }
  
  const absValue = Math.abs(value);
  let magnitude;
  
  // Cascading ifs to replace Math.log10 - optimized for common power values
  if (absValue >= 1000) {
    if (absValue >= 1000000) {
      if (absValue >= 1000000000) {
        if (absValue >= 10000000000) magnitude = 10;
        else magnitude = 9;
      } else if (absValue >= 100000000) {
        magnitude = 8;
      } else if (absValue >= 10000000) {
        magnitude = 7;
      } else {
        magnitude = 6;
      }
    } else {
      if (absValue >= 100000) magnitude = 5;
      else if (absValue >= 10000) magnitude = 4;
      else magnitude = 3;
    }
  } else if (absValue >= 1) {
    if (absValue >= 100) magnitude = 2;
    else if (absValue >= 10) magnitude = 1;
    else magnitude = 0;
  } else {
    // Less common: values < 1
    if (absValue >= 0.1) magnitude = -1;
    else if (absValue >= 0.01) magnitude = -2;
    else if (absValue >= 0.001) magnitude = -3;
    else if (absValue >= 0.0001) magnitude = -4;
    else if (absValue >= 0.00001) magnitude = -5;
    else if (absValue >= 0.000001) magnitude = -6;
    else if (absValue >= 0.0000001) magnitude = -7;
    else if (absValue >= 0.00000001) magnitude = -8;
    else if (absValue >= 0.000000001) magnitude = -9;
    else {
      // Fallback for very small values
      magnitude = Math.floor(Math.log10(absValue));
    }
  }
  
  // For large integers (magnitude >= 4), preserve all digits
  if (magnitude >= 4) {
    return String(Math.round(value));
  }
  
  // Calculate decimal places needed for 4 significant figures
  const decimalPlaces = 3 - magnitude;
  
  // Use lookup table for common powers of 10
  const powers = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000];
  const factor = decimalPlaces < powers.length ? powers[decimalPlaces] : Math.pow(10, decimalPlaces);
  
  const rounded = Math.round(value * factor) / factor;
  
  // Fast integer check
  const intVal = Math.round(rounded);
  if (Math.abs(rounded - intVal) < 1e-10) {
    return String(intVal);
  }
  
  // Format with appropriate decimal places and remove trailing zeros
  let result = rounded.toFixed(decimalPlaces);
  
  // Remove trailing zeros after decimal point
  if (result.includes('.')) {
    result = result.replace(/\.?0+$/, '');
  }
  
  return result;
}

// Array-based implementations (what we actually want to optimize)
function formatArrayCurrent(values) {
  const result = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    result[i] = values[i] === null ? null : formatSingleCurrent(values[i]);
  }
  return result;
}

function formatArrayOptimized(values) {
  const result = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    result[i] = values[i] === null ? null : formatSingleOptimized(values[i]);
  }
  return result;
}

// Advanced ultra-optimized implementation with aggressive optimizations
function formatArrayAdvancedUltra(values) {
  const result = new Array(values.length);
  const len = values.length;
  
  // Cache common strings
  const ZERO = '0';
  const NAN = 'NaN';
  const INF = 'Infinity';
  const NEG_INF = '-Infinity';
  
  // Main processing loop - optimized for most common cases first
  for (let i = 0; i < len; i++) {
    const value = values[i];
    
    // Fast path for common cases
    if (value !== null && value !== 0) {
      // Most energy values are finite positive numbers
      if (value > 0 && value < 10000) {
        // Most common: 100-5000W power values
        if (value >= 100) {
          if (value >= 1000) {
            // 1000-9999: integers only
            result[i] = '' + Math.round(value);
          } else {
            // 100-999: 1 decimal
            result[i] = '' + (Math.round(value * 10) / 10);
          }
        }
        // 10-99: 2 decimals
        else if (value >= 10) {
          result[i] = '' + (Math.round(value * 100) / 100);
        }
        // 1-9: 3 decimals
        else if (value >= 1) {
          result[i] = '' + (Math.round(value * 1000) / 1000);
        }
        // 0.1-0.999: 4 decimals
        else if (value >= 0.1) {
          result[i] = '' + (Math.round(value * 10000) / 10000);
        }
        // 0.01-0.099: 5 decimals
        else if (value >= 0.01) {
          result[i] = '' + (Math.round(value * 100000) / 100000);
        }
        // 0.001-0.009: 6 decimals
        else if (value >= 0.001) {
          result[i] = '' + (Math.round(value * 1000000) / 1000000);
        }
        // Very small positive
        else {
          result[i] = formatSingleOptimized(value);
        }
      }
      // Handle negatives and large values
      else if (isFinite(value)) {
        const absValue = Math.abs(value);
        
        // Large values >= 10000
        if (absValue >= 10000) {
          result[i] = '' + Math.round(value);
        }
        // Negative values in common ranges
        else if (absValue >= 100) {
          if (absValue >= 1000) {
            result[i] = '' + Math.round(value);
          } else {
            result[i] = '' + (Math.round(value * 10) / 10);
          }
        }
        else if (absValue >= 10) {
          result[i] = '' + (Math.round(value * 100) / 100);
        }
        else if (absValue >= 1) {
          result[i] = '' + (Math.round(value * 1000) / 1000);
        }
        else if (absValue >= 0.1) {
          result[i] = '' + (Math.round(value * 10000) / 10000);
        }
        else if (absValue >= 0.01) {
          result[i] = '' + (Math.round(value * 100000) / 100000);
        }
        else if (absValue >= 0.001) {
          result[i] = '' + (Math.round(value * 1000000) / 1000000);
        }
        else {
          result[i] = formatSingleOptimized(value);
        }
      }
      // Non-finite values
      else {
        if (value !== value) result[i] = NAN;
        else if (value === Infinity) result[i] = INF;
        else result[i] = NEG_INF;
      }
    }
    // Special cases
    else if (value === 0) {
      result[i] = ZERO;
    }
    else {
      result[i] = null;
    }
  }
  
  return result;
}

// Ultra-optimized array implementation with improved logic
function formatArrayUltra(values) {
  const result = new Array(values.length);
  
  // Pre-computed powers of 10 for fast lookup
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
    
    // All large values >= 1000 (combines previous 1000-10000 and >=10000 checks)
    if (absValue >= 1000) {
      result[i] = String(Math.round(value));
      continue;
    }
    
    // Direct factor calculation based on range
    let factor;
    if (absValue >= 100) {
      // 100-999: 1 decimal place
      factor = 10;
    } else if (absValue >= 10) {
      // 10-99: 2 decimal places
      factor = 100;
    } else if (absValue >= 1) {
      // 1-9: 3 decimal places
      factor = 1000;
    } else if (absValue >= 0.1) {
      // 0.1-0.999: 4 decimal places
      factor = 10000;
    } else if (absValue >= 0.01) {
      // 0.01-0.099: 5 decimal places
      factor = 100000;
    } else if (absValue >= 0.001) {
      // 0.001-0.009: 6 decimal places
      factor = 1000000;
    } else {
      // Very small values - fallback to optimized single
      result[i] = formatSingleOptimized(value);
      continue;
    }
    
    // Single rounding operation and string conversion
    const rounded = Math.round(value * factor) / factor;
    result[i] = String(rounded);
  }
  
  return result;
}

// Comprehensive test cases
const testCases = [
  // Basic cases
  { input: 0, expected: '0' },
  { input: 1, expected: '1' },
  { input: -1, expected: '-1' },
  
  // Standard decimal numbers (4 sig figs)
  { input: 1234.5678, expected: '1235' },
  { input: 1234.4321, expected: '1234' },
  { input: 123.456, expected: '123.5' },
  { input: 12.3456, expected: '12.35' },
  { input: 1.23456, expected: '1.235' },
  { input: 0.123456, expected: '0.1235' },
  
  // Large numbers (preserve all digits left of decimal)
  { input: 1234567, expected: '1234567' },
  { input: 12345678, expected: '12345678' },
  { input: 123456789, expected: '123456789' },
  { input: 1234567.89, expected: '1234568' },
  
  // Small numbers
  { input: 0.00012345, expected: '0.0001235' },
  { input: 0.000012345, expected: '0.00001235' },
  { input: 1.234e-6, expected: '0.000001234' },
  { input: 1.234e-9, expected: '0.000000001234' },
  
  // Negative numbers
  { input: -1234.5678, expected: '-1235' },
  { input: -123.456, expected: '-123.5' },
  { input: -0.123456, expected: '-0.1235' },
  
  // Power values (typical energy data)
  { input: 2500, expected: '2500' },
  { input: 2567.89, expected: '2568' },
  { input: 250.5, expected: '250.5' },
  { input: 25.55, expected: '25.55' },
  { input: 0.5, expected: '0.5' },
  
  // Percentage values (battery SOC)
  { input: 100, expected: '100' },
  { input: 99.9, expected: '99.9' },
  { input: 50.5, expected: '50.5' },
  { input: 25.25, expected: '25.25' },
  { input: 75.5555, expected: '75.56' },
  
  // Edge cases
  { input: 0.9999, expected: '0.9999' },
  { input: 9.9999, expected: '10' },
  { input: 99.999, expected: '100' },
  { input: 999.99, expected: '1000' },
  { input: 9999.9, expected: '10000' },
  
  // Special values
  { input: NaN, expected: 'NaN' },
  { input: Infinity, expected: 'Infinity' },
  { input: -Infinity, expected: '-Infinity' },
  { input: null, expected: null },
];

// Test function for arrays
function testArrayImplementation(fn, name) {
  console.log(`\nTesting ${name}...`);
  
  // Create test arrays
  const inputs = testCases.map(tc => tc.input);
  const expected = testCases.map(tc => tc.expected);
  
  // Run the function
  const results = fn(inputs);
  
  // Check results
  let failures = 0;
  for (let i = 0; i < testCases.length; i++) {
    if (results[i] !== expected[i]) {
      failures++;
      if (failures <= 5) {
        console.log(`  ${RED}✗ ${inputs[i]} → "${results[i]}" (expected: "${expected[i]}")${RESET}`);
      }
    }
  }
  
  if (failures === 0) {
    console.log(`  ${GREEN}✓ All ${testCases.length} tests passed${RESET}`);
    return true;
  } else {
    console.log(`  ${RED}✗ ${failures} tests failed${RESET}`);
    return false;
  }
}

// Generate realistic test data
function generateTestData(size) {
  const data = [];
  
  // Typical power values (40% of data)
  const powerCount = Math.floor(size * 0.4);
  for (let i = 0; i < powerCount; i++) {
    data.push(100 + Math.random() * 5000);
  }
  
  // Battery SOC percentages (20% of data)
  const socCount = Math.floor(size * 0.2);
  for (let i = 0; i < socCount; i++) {
    data.push(Math.random() * 100);
  }
  
  // Large values (10% of data)
  const largeCount = Math.floor(size * 0.1);
  for (let i = 0; i < largeCount; i++) {
    data.push(10000 + Math.random() * 90000);
  }
  
  // Negative values (20% of data)
  const negativeCount = Math.floor(size * 0.2);
  for (let i = 0; i < negativeCount; i++) {
    data.push(-Math.random() * 5000);
  }
  
  // Small values (5% of data)
  const smallCount = Math.floor(size * 0.05);
  for (let i = 0; i < smallCount; i++) {
    data.push(Math.random());
  }
  
  // Very small values (3% of data)
  const verySmallCount = Math.floor(size * 0.03);
  for (let i = 0; i < verySmallCount; i++) {
    data.push(Math.random() * 0.001);
  }
  
  // Add some nulls (2% of data)
  const nullCount = Math.floor(size * 0.02);
  for (let i = 0; i < nullCount; i++) {
    data.push(null);
  }
  
  // Shuffle the array
  for (let i = data.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [data[i], data[j]] = [data[j], data[i]];
  }
  
  return data;
}

// Extended benchmark for arrays
function benchmarkArrayProcessing(fn, testArrays, minDurationMs, name) {
  console.log(`\n${BLUE}Benchmarking ${name}...${RESET}`);
  
  // Warm up
  console.log('  Warming up...');
  for (let i = 0; i < 100; i++) {
    fn(testArrays[i % testArrays.length]);
  }
  
  let iterations = 0;
  const startTime = process.hrtime.bigint();
  let currentTime = startTime;
  let lastUpdate = startTime;
  
  // Run for at least minDurationMs
  while (Number(currentTime - startTime) / 1000000 < minDurationMs) {
    // Process arrays in sequence
    for (let i = 0; i < 100; i++) {
      fn(testArrays[(iterations + i) % testArrays.length]);
    }
    iterations += 100;
    
    currentTime = process.hrtime.bigint();
    
    // Update progress every second
    if (Number(currentTime - lastUpdate) / 1000000 > 1000) {
      const elapsed = Number(currentTime - startTime) / 1000000;
      const progress = (elapsed / minDurationMs * 100).toFixed(1);
      process.stdout.write(`\r  Progress: ${progress}% (${iterations.toLocaleString()} arrays processed)`);
      lastUpdate = currentTime;
    }
  }
  
  const endTime = process.hrtime.bigint();
  const totalTimeMs = Number(endTime - startTime) / 1000000;
  const arraysPerSec = iterations / (totalTimeMs / 1000);
  const elementsProcessed = iterations * testArrays[0].length;
  const elementsPerSec = elementsProcessed / (totalTimeMs / 1000);
  
  console.log(`\r  ${GREEN}Complete: ${iterations.toLocaleString()} arrays (${elementsProcessed.toLocaleString()} elements) in ${(totalTimeMs/1000).toFixed(2)}s${RESET}`);
  
  return {
    name,
    iterations,
    elementsProcessed,
    totalTimeMs,
    arraysPerSec,
    elementsPerSec
  };
}

// Main execution
console.log(`${BOLD}=============================================================`);
console.log(`FORMATPRECISION ARRAY PROFILING SUITE`);
console.log(`Testing: number[] → string[] transformation`);
console.log(`=============================================================\n${RESET}`);

// Test all implementations
console.log(`${BOLD}CORRECTNESS VALIDATION${RESET}`);
console.log('----------------------');
const currentValid = testArrayImplementation(formatArrayCurrent, 'Current Array Implementation');
const optimizedValid = testArrayImplementation(formatArrayOptimized, 'Optimized Array Implementation');
const ultraValid = testArrayImplementation(formatArrayUltra, 'Ultra Array Implementation');
const advancedValid = testArrayImplementation(formatArrayAdvancedUltra, 'Advanced Ultra Implementation');

if (!currentValid || !optimizedValid || !ultraValid || !advancedValid) {
  console.log(`\n${RED}${BOLD}ERROR: Implementations do not pass correctness tests${RESET}`);
  process.exit(1);
}

// Generate test arrays
console.log(`\n${BOLD}PREPARING TEST DATA${RESET}`);
console.log('-------------------');
const arraySize = 1000;  // Size of each array
const numArrays = 1000;  // Number of test arrays
const testArrays = [];

for (let i = 0; i < numArrays; i++) {
  testArrays.push(generateTestData(arraySize));
}

console.log(`Generated ${numArrays.toLocaleString()} arrays of ${arraySize.toLocaleString()} elements each`);
console.log(`Total elements: ${(numArrays * arraySize).toLocaleString()}`);

// Verify outputs match
console.log('\nVerifying implementations produce identical outputs...');
let differences = 0;
const sampleArray = testArrays[0];
const currentResults = formatArrayCurrent(sampleArray);
const optimizedResults = formatArrayOptimized(sampleArray);
const ultraResults = formatArrayUltra(sampleArray);
const advancedResults = formatArrayAdvancedUltra(sampleArray);

for (let i = 0; i < sampleArray.length; i++) {
  if (currentResults[i] !== optimizedResults[i] || currentResults[i] !== ultraResults[i] || currentResults[i] !== advancedResults[i]) {
    differences++;
    if (differences <= 3) {
      console.log(`  ${YELLOW}Difference at index ${i}: input=${sampleArray[i]}, current="${currentResults[i]}", optimized="${optimizedResults[i]}", ultra="${ultraResults[i]}", advanced="${advancedResults[i]}"${RESET}`);
    }
  }
}

if (differences === 0) {
  console.log(`  ${GREEN}✓ All implementations produce identical outputs${RESET}`);
} else {
  console.log(`  ${YELLOW}⚠ Found ${differences} differences${RESET}`);
}

// Extended benchmarks (5 seconds each)
console.log(`\n${BOLD}EXTENDED BENCHMARKS (5+ seconds each)${RESET}`);
console.log('--------------------------------------');

const minDuration = 5000; // 5 seconds minimum
const results = [];

results.push(benchmarkArrayProcessing(formatArrayCurrent, testArrays, minDuration, 'Current (Math.log10)'));
results.push(benchmarkArrayProcessing(formatArrayOptimized, testArrays, minDuration, 'Optimized (cascading if)'));
results.push(benchmarkArrayProcessing(formatArrayUltra, testArrays, minDuration, 'Ultra (specialized)'));
results.push(benchmarkArrayProcessing(formatArrayAdvancedUltra, testArrays, minDuration, 'Advanced Ultra'));

// Display results
console.log(`\n${BOLD}ARRAY PROCESSING RESULTS${RESET}`);
console.log('------------------------');
console.log('Implementation            Arrays    Elements      Time     Arrays/sec   Elements/sec');
console.log('------------------------------------------------------------------------------------');
results.forEach(r => {
  console.log(
    `${r.name.padEnd(25)} ${r.iterations.toLocaleString().padStart(7)} ${r.elementsProcessed.toLocaleString().padStart(11)} ${(r.totalTimeMs/1000).toFixed(2).padStart(8)}s ${Math.round(r.arraysPerSec).toLocaleString().padStart(11)} ${Math.round(r.elementsPerSec).toLocaleString().padStart(14)}`
  );
});

// Calculate speedup
console.log(`\n${BOLD}PERFORMANCE COMPARISON${RESET}`);
console.log('----------------------');
const baseline = results[0];
results.slice(1).forEach(r => {
  const speedup = r.elementsPerSec / baseline.elementsPerSec;
  const improvement = ((r.elementsPerSec / baseline.elementsPerSec - 1) * 100).toFixed(1);
  console.log(`${r.name}: ${GREEN}${speedup.toFixed(2)}x faster${RESET} (${improvement}% improvement)`);
});

// Memory efficiency test
console.log(`\n${BOLD}MEMORY EFFICIENCY TEST${RESET}`);
console.log('----------------------');

const largeArray = generateTestData(10000);
console.log(`Testing with array of ${largeArray.length.toLocaleString()} elements`);

// Measure memory and time for large array
const memResults = [];
for (const [name, fn] of [
  ['Current', formatArrayCurrent],
  ['Optimized', formatArrayOptimized],
  ['Ultra', formatArrayUltra],
  ['Advanced', formatArrayAdvancedUltra]
]) {
  const startMem = process.memoryUsage().heapUsed;
  const startTime = process.hrtime.bigint();
  
  const result = fn(largeArray);
  
  const endTime = process.hrtime.bigint();
  const endMem = process.memoryUsage().heapUsed;
  
  const timeMs = Number(endTime - startTime) / 1000000;
  const memDelta = (endMem - startMem) / 1024 / 1024; // MB
  
  memResults.push({ name, timeMs, memDelta, resultLength: result.length });
  console.log(`${name.padEnd(10)}: ${timeMs.toFixed(2)}ms, ~${memDelta.toFixed(2)}MB memory delta`);
}

// Summary
console.log(`\n${BOLD}=============================================================`);
console.log(`PROFILING COMPLETE${RESET}`);
console.log(`${BOLD}=============================================================\n${RESET}`);

console.log(`${GREEN}✓ All implementations pass correctness tests${RESET}`);
console.log(`${GREEN}✓ Input: number arrays with nulls${RESET}`);
console.log(`${GREEN}✓ Output: string arrays with proper OpenNEM formatting${RESET}`);
console.log(`${GREEN}✓ Performance gain: ${(results[1].elementsPerSec / baseline.elementsPerSec).toFixed(2)}x optimized, ${(results[2].elementsPerSec / baseline.elementsPerSec).toFixed(2)}x ultra, ${(results[3].elementsPerSec / baseline.elementsPerSec).toFixed(2)}x advanced${RESET}`);
console.log(`${GREEN}✓ Ready for production integration${RESET}`);

// Export for use in other modules
module.exports = {
  formatArrayCurrent,
  formatArrayOptimized,
  formatArrayUltra,
  formatArrayAdvancedUltra,
  testCases,
  testArrayImplementation
};