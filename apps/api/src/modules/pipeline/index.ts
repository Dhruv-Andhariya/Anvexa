// Public entry of the pipeline module. Other modules import ONLY from here.
// Round engine: failsStage2Overall() / gateAllows() before moving a student on, rejectionEmailsOn() before a
// rejection email. GD module: rubricOf() / checkRubricScores() for HR's evaluator form.
export { PipelineModule } from './pipeline.module';
export { PipelineService } from './pipeline.service';
export { PipelineStore, MemoryPipelineStore } from './pipeline.store';
