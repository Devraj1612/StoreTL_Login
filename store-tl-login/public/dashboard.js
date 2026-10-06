'use strict';

const $ = (id) => document.getElementById(id);
const shifts = {
  morning: '6:00 AM – 3:00 PM',
  midday: '10:00 AM – 7:00 PM',
  evening: '3:00 PM – 12:30 AM',
};

function feedback(message, bad = false) {
  const el = $('formFeedback');
  el.textContent = message;
  el.className = 'form-feedback ' + (bad ? 'error' : 'success');
}

function updateBreach() {
  const value = Number($('breachPercent').value) || 0;
  const percent = Math.max(0, Math.min(100, value));
  $('meterFill').style.width = `${percent}%`;
  $('meterValue').textContent = `${percent.toFixed(percent % 1 ? 2 : 0)}% breach`;
  $('causeField').classList.toggle('cause-required', value > 0);
  $('rootCause').required = value > 0;
}

async function loadReport() {
  $('savedIndicator').textContent = 'Loading report…';
  $('formFeedback').classList.add('hidden');
  try {
    const { report } = await api('/api/performance?date=' + encodeURIComponent($('reportDate').value));
    $('breachPercent').value = report ? report.breach_percent : '';
    $('rootCause').value = report ? report.delay_root_cause : '';
    $('savedIndicator').textContent = report ? `Updated ${new Date(report.updated_at).toLocaleString()}` : 'No report for this date';
    $('reportStateValue').textContent = report ? 'Submitted' : 'Not submitted';
    $('reportStateDetail').textContent = report ? `Entry for ${$('reportDate').value}` : 'Complete the report below';
    $('breachSummary').textContent = report ? `${Number(report.breach_percent).toFixed(2)}%` : '—';
    $('updatedSummary').textContent = report ? new Date(report.updated_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
    $('charCount').textContent = $('rootCause').value.length;
    updateBreach();
  } catch (error) {
    $('savedIndicator').textContent = 'Could not load report';
    $('reportStateValue').textContent = 'Unavailable';
    $('reportStateDetail').textContent = 'Refresh the page to try again';
    feedback(error.message, true);
  }
}

(async () => {
  try {
    const me = await api('/api/me');
    $('hello').textContent = `Welcome, ${me.name}`;
    $('who').textContent = me.name;
    $('where').textContent = `${me.store_name}, ${me.city}  ·  Login ID ${me.login_id}`;
    $('shiftName').textContent = shifts[me.shift_code] || 'Shift not assigned';
    $('todayLabel').textContent = `TODAY · ${me.today}`;
    $('reportDate').value = me.today;
    await loadReport();
  } catch {
    location.href = 'index.html';
  }
})();

$('reportDate').addEventListener('change', loadReport);
$('breachPercent').addEventListener('input', updateBreach);
$('rootCause').addEventListener('input', () => { $('charCount').textContent = $('rootCause').value.length; });
$('performanceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('formFeedback').classList.add('hidden');
  const breach = Number($('breachPercent').value);
  if (!Number.isFinite(breach) || breach < 0 || breach > 100) return feedback('Enter a breach percentage from 0 to 100.', true);
  if (breach > 0 && !$('rootCause').value.trim()) return feedback('Add the delay root-cause analysis before saving.', true);
  $('saveReport').disabled = true;
  $('saveReport').textContent = 'Saving…';
  try {
    await api('/api/performance', { method: 'POST', body: {
      report_date: $('reportDate').value,
      breach_percent: breach,
      delay_root_cause: $('rootCause').value.trim(),
    } });
    await loadReport();
    feedback('Performance report saved. Your admin can now view it.');
  } catch (error) {
    feedback(error.message, true);
  } finally {
    $('saveReport').disabled = false;
    $('saveReport').textContent = 'Save performance';
  }
});
$('out').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.href = 'index.html'; };
